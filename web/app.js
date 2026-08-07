/**
 * app.js —— DOM 绑定层。
 *
 * 只做三件事:轮询 /api/* 填数字、SSE 收日志、按钮发命令。
 * 所有"算出来的东西"在 core.js 里,这儿不重复计算。
 */

import {
  LOG_LEVELS, fmtCount, fmtTokens, fmtUptime, fmtClock,
  successRate, fmtPercent, cooldownDeadline, remainMs, nodeRows,
  pushLog, maskKey, endpointBase, rankBreakdown, COOLDOWN_MS,
  fmtDelay, delayGrade, fmtAgo, hasNewer, nodeStats, configPayload,
} from './core.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;

/** 界面状态。cooldowns 存的是本地截止时间戳,不是服务端给的秒数 */
const S = {
  cfg: {}, status: {}, usage: null,
  nodes: [], cooldowns: [], current: '', locked: '',
  delay: {}, excluded: [], testedAt: null, testing: false,
  logs: [], filter: 'all', follow: true,
  // 检查更新查到的远端 hash。记 hash 而不是布尔:更新完镜像重启后 status 里的
  // build 就变成它,「有新版本」标记自己消失,不用再点一次才知道好了
  latest: '',
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
  // 会话过期或被退出了。回登录页,而不是让轮询一直红着「连接不上后端」——
  // 后端好得很,是这张 cookie 不认了
  if (r.status === 401) {
    location.replace('/login');
    throw new Error('未登录');
  }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ── 渲染 ────────────────────────────────────────────────

function setPill(el, cls, text) {
  el.className = `pill ${cls}`;
  el.querySelector('[data-t]').textContent = text;
}

/**
 * 「订阅地址」右端那一个状态灯。原来是三个:网关的端口在接入卡的 Base URL 上
 * 已经有了,内核版本看一眼就够、不会变,真会动的只有节点数,所以只留这一个。
 *
 * 内核挂了的时候借它报出来 —— 只显示「无节点」的话,看不出是订阅没填还是
 * 内核死了,而这两件事要做的处置完全不同。
 */
function renderPills() {
  const st = S.status;
  if (!st.mihomoRunning) return setPill($('pill-node'), 'down', '内核未运行');

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
  $('nodes-tested').textContent = S.testing ? '测延迟中…' : fmtAgo(S.testedAt);

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

/** 「标签 + 值」那一小块。值加粗,标签留灰,扫的时候只看粗体就行 */
function num(cls, label, value) {
  const s = tag(`num ${cls}`, `${label} `);
  const b = document.createElement('b');
  b.textContent = value;
  s.append(b);
  return s;
}

/**
 * 节点统计卡。数据来自 usage.byNode —— **每次真实上游尝试**记一笔,
 * 和顶部总览那套「一次客户端请求记一次」不是同一个口径,卡头那句提示
 * 就是为了让人别把两个数当成同一件事去对(见 core.js 的 nodeStats)。
 */
function renderNodeStats() {
  const { rows, totals } = nodeStats(S.usage?.byNode);
  $('nstat-empty').hidden = rows.length > 0;
  $('nstat-sum').textContent = rows.length
    ? `总尝试 ${fmtCount(totals.requests)} · 成功 ${fmtCount(totals.success)}`
      + ` · 429 ${fmtCount(totals.rateLimited)} · 超时 ${fmtCount(totals.timeout)}`
      + ` · 上游错误 ${fmtCount(totals.upstreamError)}`
    : '按每次真实上游尝试计,和顶部的请求总数不是同一个口径。';

  $('nstats').replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'nstat';

    const nm = tag('nm', r.name);
    nm.title = r.name;
    const main = document.createElement('div');
    main.className = 'nstat-main';
    main.append(
      nm,
      num('', '尝试', fmtCount(r.requests)),
      num('', '成功率', fmtPercent(r.rate)),
      // 上游没报 cached_tokens 时 cache 是 null → '—'。显示 0% 会被读成
      // 「试过、一次没命中」,而真相是「上游根本没给这个数」
      num(r.cache ? 'hit' : '', '缓存命中', fmtPercent(r.cache)),
    );

    const sub = document.createElement('p');
    sub.className = 'sub';
    const bad = (label, n) => {
      sub.append(tag(n ? 'bad' : '', `${label} ${fmtCount(n)}`), document.createTextNode(' · '));
    };
    bad('429', r.rateLimited);
    bad('超时', r.timeout);
    bad('上游错误', r.upstreamError);
    sub.append(document.createTextNode(
      `Token ${fmtTokens(r.totalTokens)}(入 ${fmtTokens(r.promptTokens)}`
      + ` · 出 ${fmtTokens(r.completionTokens)} · 推理 ${fmtTokens(r.reasoningTokens)}`
      + ` · 缓存读 ${fmtTokens(r.cacheReadTokens)} / 写 ${fmtTokens(r.cacheWriteTokens)})`));

    li.append(main, sub);
    return li;
  }));
}

function renderConn() {
  $('f-base').value = endpointBase(location.origin);
  // 屏幕上永远是掩码;要用就点「复制」,那条路复制的是真值
  $('f-key').value = maskKey(S.cfg.apiKey || '');
}

/**
 * 可用模型。服务端从上游 /zen/v1/models 现拉(缓存 30 分钟),这里只负责贴。
 * 写死在前端的那份漏过一个新上线的免费模型,所以不再留本地常量做兜底 ——
 * 兜底在服务端,前端拿到什么就显示什么。
 */
function renderModels() {
  const list = Array.isArray(S.status.models) ? S.status.models : [];
  const ul = $('models');
  // 列表几周才变一次,但重建 8 个 <li> 的代价比比对差异还小
  ul.replaceChildren(...list.map((m) => {
    const li = document.createElement('li');
    li.textContent = m;
    return li;
  }));
}

function renderBuild() {
  const { build = '', buildUrl = '', repoUrl = '', trackRef = '' } = S.status;
  const el = $('build-id');
  el.textContent = build || '—';
  if (buildUrl || repoUrl) el.href = buildUrl || repoUrl;
  if (repoUrl) $('repo-link').href = repoUrl;

  const stale = hasNewer(S.latest, build);
  el.classList.toggle('new', stale);
  // 徽标只有 7 个字符,「跟谁比的」放 title 里 —— 不然「有新版本」这个状态
  // 看不出是拿哪个分支比出来的
  el.title = build
    ? `当前构建 ${build}${trackRef ? ` · 跟随 ${trackRef} 分支` : ''}${stale ? ` · 有新版本 ${S.latest}` : ''}`
    : '构建标识未知(构建时没注入 GIT_COMMIT)';
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

    renderPills(); renderStats(); renderNodes(); renderNodeStats();
    renderConn(); renderModels(); renderBuild();

    // 表单不在用户编辑时才回填,否则打字会被覆盖
    if (document.activeElement !== $('f-sub')) $('f-sub').value = S.cfg.subscriptionUrl || '';
    // 开关同理:用户刚点完还没提交时别被轮询拨回去
    const idt = $('f-identity');
    if (document.activeElement !== idt) idt.checked = S.cfg.opencodeIdentityHeaders === true;
    syncIdentityTag();
  } catch (e) {
    setPill($('pill-node'), 'down', '连接不上后端');
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

/** checkbox 旁边那个「关闭 / 实验中」标签。颜色靠 CSS 的 :checked,这里只管文字 */
function syncIdentityTag() {
  $('f-identity-state').textContent = $('f-identity').checked ? '实验中' : '关闭';
}

function wire() {
  $('btn-restart').onclick = (e) => run(e.target, '内核重启', () => api('/restart', { method: 'POST' }));
  $('btn-reset').onclick = (e) => run(e.target, '手动重置', () => api('/reset', { method: 'POST' }));

  // 退出登录:不走 run()(它要改按钮文字,会把里面的 svg 抹掉)。
  // 请求失败也照样回登录页 —— 用户的意图是「离开」,不该被一个失败的请求拦下
  $('btn-logout').onclick = async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* 下面照样跳 */ }
    location.replace('/login');
  };

  // 重置 Key 要二次确认:它就在「复制」旁边,点错的话所有在用的客户端立刻 401
  $('btn-regen').onclick = (e) => {
    if (!confirm('重置 API Key?正在用旧 Key 的客户端会全部收到 401,需要重新填。')) return;
    run(e.target, '重置 Key', () => api('/regen-key', { method: 'POST' }));
  };

  $('btn-speed').onclick = (e) => run(e.target, '测延迟', async () => {
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

  // 检查更新走自己的 handler 而不是 run():run 会把按钮文字换成「处理中…」,
  // 那会连带把里面的 svg 抹掉;而且它最后要 refresh() 一遍,这里没必要。
  $('btn-update').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('spin');
    try {
      const r = await api('/check-update', { method: 'POST' });
      S.latest = r?.latest || '';
      if (r?.error) toast(`检查更新失败:${r.error}`, 'err');
      else if (r?.hasUpdate) toast(`有新版本 ${r.latest} —— docker compose pull 后重启容器`, 'ok');
      else toast(`已是最新${r?.current ? ` ${r.current}` : ''}`, 'ok');
    } catch (err) {
      toast(`检查更新失败:${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('spin');
      renderBuild();
    }
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

    // 提交前挡一道:订阅地址错了会让内核重启后拿不到节点
    if (url && !/^https?:\/\/.+/i.test(url)) {
      err.textContent = '订阅地址要以 http:// 或 https:// 开头';
      err.hidden = false;
      return;
    }
    err.hidden = true;

    // 订阅地址 + 身份头开关一起提交。端口不在这张表里 —— 服务端本来也不接受
    // 改端口(容器对外端口由 compose 的 ports 定),发过去只会被忽略。
    // 身份头单独切的时候订阅地址没变,服务端那边一步内核操作都不会做。
    run($('btn-save'), '保存', async () => {
      const r = await api('/config', {
        method: 'POST',
        body: JSON.stringify(configPayload({
          savedUrl: S.cfg.subscriptionUrl || '',
          url,
          savedIdentity: S.cfg.opencodeIdentityHeaders === true,
          identity: $('f-identity').checked,
        })),
      });
      if (r?.nodes == null) return '';
      // 保存会顺带测一遍延迟。测完了就把可用数一起说了,没测完(节点多、超了
      // 20 秒)只报节点数,结果稍后自己出现在节点池里
      const s = r.speed;
      return s ? `刷到 ${r.nodes} 个节点,${s.alive}/${s.tested} 可用` : `刷到 ${r.nodes} 个节点`;
    });
  };

  // 勾了就立刻改标签文字,不等「保存并应用」—— 但真正生效还是在提交之后
  $('f-identity').onchange = syncIdentityTag;

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
