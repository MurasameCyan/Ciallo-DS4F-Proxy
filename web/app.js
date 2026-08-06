/**
 * app.js —— DOM 绑定层。
 *
 * 只做三件事:轮询 /api/* 填数字、SSE 收日志、按钮发命令。
 * 所有"算出来的东西"在 core.js 里,这儿不重复计算。
 */

import {
  FREE_MODELS, LOG_LEVELS, fmtCount, fmtTokens, fmtUptime, fmtClock,
  successRate, fmtPercent, cooldownDeadline, remainMs, nodeRows,
  pushLog, maskKey, endpointBase, rankBreakdown, COOLDOWN_MS,
  fmtDelay, delayGrade, fmtAgo,
} from './core.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;

/** 界面状态。cooldowns 存的是本地截止时间戳,不是服务端给的秒数 */
const S = {
  cfg: {}, status: {}, usage: null,
  nodes: [], cooldowns: [], current: '', locked: '',
  delay: {}, excluded: [], testedAt: null, testing: false,
  logs: [], filter: 'all', follow: true, showKey: false,
};

// ── HTTP ────────────────────────────────────────────────

async function api(path, opts) {
  const r = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就当空 */ }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ── 渲染 ────────────────────────────────────────────────

function setPill(el, cls, text) {
  el.className = `pill ${cls}`;
  el.querySelector('[data-t]').textContent = text;
}

function renderPills() {
  const st = S.status;
  setPill($('pill-gw'), st.gatewayRunning ? 'up' : 'down',
    st.gatewayRunning ? `网关 :${st.gatewayPort}` : '网关未运行');
  setPill($('pill-mh'), st.mihomoRunning ? 'up' : 'down',
    st.mihomoRunning ? `内核 ${st.mihomoVersion || ''}`.trim() : '内核未运行');

  // 只数还在轮换表里的冷却:已经被剔除的节点显示的是「不可用」,
  // 再从可用数里扣一次就成了双重扣减(分子会比实际少)
  const cooling = S.cooldowns.filter((c) => remainMs(c.deadline) > 0 && S.nodes.includes(c.node)).length;
  // 分母算上被剔除的:订阅里有 17 个就该显示 /17,少掉的那几个正是要看见的信息
  const total = S.nodes.length + S.excluded.length;
  setPill($('pill-node'), cooling ? 'cool' : total ? 'up' : '',
    total ? `节点 ${S.nodes.length - cooling}/${total} 可用` : '无节点');
}

function renderStats() {
  const t = S.usage?.total;
  if (!t) return;

  $('s-req').textContent = fmtCount(t.requests);
  $('s-req-sub').textContent = `成功 ${fmtCount(t.success)} · 失败 ${fmtCount(t.fail)}`;

  const rate = successRate(t);
  $('s-rate').textContent = fmtPercent(rate);
  $('s-rate-bar').style.width = `${(rate ?? 0) * 100}%`;

  $('s-tok').textContent = fmtTokens(t.totalTokens);
  $('s-tok-sub').textContent =
    `输入 ${fmtTokens(t.promptTokens)} · 输出 ${fmtTokens(t.completionTokens)} · 推理 ${fmtTokens(t.reasoningTokens)}`;

  $('s-up').textContent = fmtUptime(Date.now() - (S.usage.startTime || Date.now()));
  const top = rankBreakdown(S.usage.byModel, 1)[0];
  $('s-up-sub').textContent = S.usage.lastRequest
    ? `最后请求 ${fmtClock(S.usage.lastRequest)}${top ? ` · 主用 ${top.key}` : ''}`
    : '还没有请求';
}

function renderNodes() {
  const rows = nodeRows({ ...S, now: Date.now() });
  const ul = $('nodes');
  $('nodes-empty').hidden = rows.length > 0;
  $('nodes-tested').textContent = S.testing ? '测速中…' : fmtAgo(S.testedAt);

  // 全量重建。节点数是几十条量级,重建比 diff 简单且看不出差别。
  // ponytail: 上限约几百条;再多要改成按 name 复用 <li>。
  ul.replaceChildren(...rows.map((n, k) => {
    const li = document.createElement('li');
    li.className = `node ${n.state}`;

    // 编号用排序后的位次,不是订阅里的下标(n.i)。卡片说「从上往下就是网关
    // 接下来会用的顺序」,那这一列就得是那个顺序;拿订阅下标去标一个已排过序
    // 的列表,冷却的节点被排到看不见的下面之后,剩下的会显示成 1,2,3,4,7,8,
    // 读着像丢了两行。要回查订阅位置的话节点名本来就是唯一的。
    const idx = document.createElement('span');
    idx.className = 'idx';
    // 被剔除的不给编号:它们不在轮换序列里,给了会让人以为还排着队
    idx.textContent = n.state === 'dead' ? '×' : k + 1;

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = n.name;
    nm.title = n.name;

    const ms = document.createElement('span');
    ms.className = `ms ${delayGrade(n.latency)}`;
    ms.textContent = fmtDelay(n.latency);

    const st = document.createElement('span');
    st.className = 'st';
    if (n.state === 'dead') {
      st.append(tag('badge dead', '不可用'));
    } else if (n.state === 'active') {
      st.append(tag('badge on', '在用'));
    } else if (n.state === 'cooling') {
      st.append(tag('badge cool', `冷却 ${Math.ceil(n.remain / 1000)}s`));
    } else {
      st.append(tag('badge', '待用'));
    }

    li.append(idx, nm, ms, st);
    return li;
  }));
}

function tag(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function renderConn() {
  $('f-base').value = endpointBase(location.origin);
  const key = S.cfg.apiKey || '';
  $('f-key').value = S.showKey ? key : maskKey(key);
}

function renderLog() {
  const box = $('log');
  const shown = S.filter === 'all' ? S.logs : S.logs.filter((l) => l.level === S.filter);

  box.replaceChildren(...shown.map((l) => {
    const li = document.createElement('li');
    li.className = l.level || 'info';

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtClock(l.ts);

    const m = document.createElement('span');
    m.className = 'm';
    // 读屏听到的是纯文本,级别靠颜色区分不够,补个前缀
    m.textContent = `${LOG_LEVELS[l.level] ? `[${LOG_LEVELS[l.level]}] ` : ''}${l.msg}`;

    li.append(t, m);
    return li;
  }));

  if (S.follow) box.scrollTop = box.scrollHeight;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

// ── 轮询 ────────────────────────────────────────────────

async function refresh() {
  try {
    const [status, cfg, usage, pool] = await Promise.all([
      api('/status'), api('/config'), api('/usage'), api('/nodes'),
    ]);
    S.status = status || {};
    S.cfg = cfg || {};
    S.usage = usage;
    S.nodes = pool?.nodes || [];
    S.current = pool?.current || '';
    S.locked = pool?.locked || '';
    S.delay = pool?.delay || {};
    S.excluded = pool?.excluded || [];
    S.testedAt = pool?.testedAt || null;
    S.testing = pool?.testing === true;
    // 服务端给秒,进来立刻折算成本地截止点,之后本地走秒不用等下次轮询
    S.cooldowns = (pool?.cooldowns || []).map((c) => ({ node: c.node, deadline: cooldownDeadline(c.remain) }));

    renderPills(); renderStats(); renderNodes(); renderConn();

    // 表单不在用户编辑时才回填,否则打字会被覆盖
    if (document.activeElement !== $('f-sub')) $('f-sub').value = S.cfg.subscriptionUrl || '';
    if (document.activeElement !== $('f-port')) $('f-port').value = S.cfg.port ?? '';
  } catch (e) {
    setPill($('pill-gw'), 'down', '连接不上后端');
  }
}

/** 冷却条每秒自己走,不等轮询 */
function tick() {
  if (S.cooldowns.some((c) => remainMs(c.deadline) > 0)) { renderNodes(); renderPills(); }
}

// ── 日志流 ──────────────────────────────────────────────

function connectLogs() {
  const es = new EventSource('/api/logs');
  es.onmessage = (ev) => {
    try {
      const line = JSON.parse(ev.data);
      // 首帧是历史快照(数组),之后是单条
      if (Array.isArray(line)) S.logs = line.slice(-500);
      else pushLog(S.logs, line);
      renderLog();
    } catch { /* 坏帧丢掉,不影响后续 */ }
  };
  // EventSource 自带重连,这里只在彻底关闭时兜底
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(connectLogs, 3000); };
}

// ── 交互 ────────────────────────────────────────────────

/** 按钮跑异步命令期间禁用,避免连点触发两次重启 */
async function run(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    // fn 可以返回一句话补在 toast 后面(比如「刷到 48 个节点」),
    // 让「保存」这种看不出效果的操作有个可见的结果
    const extra = await fn();
    toast(extra ? `${label}完成,${extra}` : `${label}完成`, 'ok');
  } catch (e) {
    toast(`${label}失败:${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    refresh();
  }
}

function wire() {
  $('models').replaceChildren(...FREE_MODELS.map((m) => {
    const li = document.createElement('li');
    li.textContent = m;
    return li;
  }));

  $('btn-restart').onclick = (e) => run(e.target, '内核重启', () => api('/restart', { method: 'POST' }));
  $('btn-reset').onclick = (e) => run(e.target, '手动重置', () => api('/reset', { method: 'POST' }));
  $('btn-regen').onclick = (e) => run(e.target, '生成新 Key', () => api('/regen-key', { method: 'POST' }));

  $('btn-speed').onclick = (e) => run(e.target, '测速', async () => {
    const r = await api('/nodes/test', { method: 'POST' });
    if (!r?.tested) return '';
    const f = r.fastest ? `最快 ${r.fastest.node} ${fmtDelay(r.fastest.delay)}` : '没有可用节点';
    return `${r.alive}/${r.tested} 可用,${f}`;
  });

  // 清零要二次确认:统计是累计值,清了拿不回来(重启也不会回来,它落盘了)
  $('btn-zero').onclick = (e) => {
    if (!confirm('清零所有统计数据?请求数、Token 用量、运行时长都会从零开始,不可恢复。')) return;
    run(e.target, '统计清零', () => api('/usage/reset', { method: 'POST' }));
  };

  $('btn-eye').onclick = (e) => {
    S.showKey = !S.showKey;
    e.target.textContent = S.showKey ? '隐藏' : '显示';
    e.target.setAttribute('aria-pressed', String(S.showKey));
    renderConn();
  };

  // 复制:key 那栏永远复制真值,不能把掩码复制出去
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.onclick = async () => {
      const text = btn.dataset.copyReal === 'key' ? (S.cfg.apiKey || '') : $(btn.dataset.copy).value;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制', 'ok');
      } catch {
        toast('复制失败,请手动选中', 'err');
      }
    };
  }

  $('cfg-form').onsubmit = (e) => {
    e.preventDefault();
    const err = $('cfg-err');
    const url = $('f-sub').value.trim();
    const port = Number($('f-port').value);

    // 提交前挡一道:订阅地址错了会让内核重启后拿不到节点
    if (url && !/^https?:\/\/.+/i.test(url)) {
      err.textContent = '订阅地址要以 http:// 或 https:// 开头';
      err.hidden = false;
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      err.textContent = '端口要是 1-65535 的整数';
      err.hidden = false;
      return;
    }
    err.hidden = true;

    run($('btn-save'), '保存', async () => {
      const r = await api('/config', { method: 'POST', body: JSON.stringify({ subscriptionUrl: url, port }) });
      if (r?.nodes == null) return '';
      // 保存会顺带测一遍延迟。测完了就把可用数一起说了,没测完(节点多、超了
      // 20 秒)只报节点数,结果稍后自己出现在节点池里
      const s = r.speed;
      return s ? `刷到 ${r.nodes} 个节点,${s.alive}/${s.tested} 可用` : `刷到 ${r.nodes} 个节点`;
    });
  };

  for (const seg of document.querySelectorAll('.seg')) {
    seg.onclick = () => {
      for (const s of document.querySelectorAll('.seg')) s.classList.toggle('on', s === seg);
      S.filter = seg.dataset.lv;
      renderLog();
    };
  }

  $('f-follow').onchange = (e) => { S.follow = e.target.checked; if (S.follow) renderLog(); };
  $('btn-logclear').onclick = () => { S.logs = []; renderLog(); };

  // 手动往上翻就停止自动滚动,翻回底部再恢复 —— 不然读旧日志会被拽走
  $('log').addEventListener('scroll', (e) => {
    const box = e.target;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (atBottom !== S.follow) {
      S.follow = atBottom;
      $('f-follow').checked = atBottom;
    }
  }, { passive: true });
}

wire();
refresh();
connectLogs();
setInterval(refresh, POLL_MS);
setInterval(tick, 1000);
