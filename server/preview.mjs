/**
 * preview.mjs —— UI 预览服务器(假数据)。
 *
 * 存在的理由不只是"看一眼界面":这里 /api/* 的形状就是真网关要实现的契约,
 * 字段直接对齐现有 desktop-app 的 IPC 返回值(get-status / get-usage /
 * get-cooldowns / get-config)。Docker 版落地时把假数据换成真调用即可,
 * 前端一行不用改。
 *
 * 假数据会自己动:请求数涨、节点偶发 429 进冷却、日志持续吐,
 * 这样冷却倒计时、自动滚动、过滤这些跟时间有关的交互才真的被验证到。
 *
 * 只监听 127.0.0.1 —— 面板明文返回 apiKey 和订阅地址,不能对外。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const COOLDOWN_MS = 90_000;
// 和 gateway.mjs 的同名常量对齐。这里不 import 它:预览刻意不依赖真网关代码,
// 否则改坏了 gateway 连预览都起不来,而预览正是用来对界面的
const CALL_LOG_LIMIT = 200;
const REPO_URL = 'https://github.com/MurasameCyan/Ciallo-Zen-Proxy';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── 假状态 ──────────────────────────────────────────────

const NODES = [
  '🇭🇰 香港 01 · IEPL', '🇭🇰 香港 02 · IEPL', '🇯🇵 日本 01 · Sony',
  '🇯🇵 日本 02 · IIJ', '🇯🇵 东京 03 · BGP', '🇸🇬 新加坡 01',
  '🇸🇬 新加坡 02 · Premium', '🇹🇼 台湾 01 · HiNet', '🇺🇸 洛杉矶 01',
  '🇺🇸 圣何塞 02 · GIA', '🇰🇷 首尔 01', '🇬🇧 伦敦 01',
];

const state = {
  cfg: {
    subscriptionUrl: 'https://demo.example.com/subscribe?token=preview',
    apiKey: 'zen-a1b2c3d4', port: 9527,
    opencodeIdentityHeaders: false, subscriptionUpdateHours: 1,
  },
  build: '9dfba56',
  hasUpdate: false,
  current: NODES[2],
  cooldowns: new Map(),          // name -> 进入冷却的时间戳
  // 假的实测延迟。故意留两个 null:那是「测过但不通」,面板要把它们
  // 单独标出来而不是静默消失 —— 不然看起来像订阅少了节点。
  delay: new Map(NODES.map((n, i) => [n, i === 4 || i === 9 ? null : 90 + i * 37 + (i % 3) * 24])),
  testedAt: Date.now() - 42_000,
  usage: {
    total: { requests: 1284, success: 1197, fail: 87, promptTokens: 2_841_302, completionTokens: 986_441, reasoningTokens: 412_887, totalTokens: 3_827_743 },
    byDay: {}, byModel: {}, byNode: {}, calls: [],
    lastRequest: Date.now() - 4200,
    startTime: Date.now() - 3600_000 * 27,
  },
  logs: [],
};

// 「模型统计」那格按 success 排序取值,所以每个都得有这个字段。
// 刻意让两种名次分叉:big-pickle 请求数(168)高于 mimo(73),但成功数(51)
// 反而更低 —— 于是预览里能看出排的是成功次数而不是请求数,写错排序键就露馅。
// 最后一个 success=0(全失败):它不该出现在列表里,列一行 0 只是占位。
state.usage.byModel['deepseek-v4-flash-free'] = { requests: 1043, success: 1002, fail: 41, totalTokens: 3_102_884 };
state.usage.byModel['big-pickle'] = { requests: 168, success: 51, fail: 117, totalTokens: 561_209 };
state.usage.byModel['mimo-v2.5-free'] = { requests: 73, success: 71, fail: 2, totalTokens: 163_650 };
state.usage.byModel['glm-5-air-free'] = { requests: 12, success: 0, fail: 12, totalTokens: 0 };

// 节点尝试口径。合计(1519)刻意大于上面的请求总数(1284):重试和换节点就是
// 这么多出来的,面板得能把这个差解释清楚,预览里没这个差就试不出那句提示。
// 前两个有缓存 token(命中率能算),第三个 cacheRead=0(显示 0%),
// 最后一个 promptTokens=0(显示 —)—— 三种状态在一屏里全见得着。
// 耗时同理凑齐三档单位:第三个节点的首字落在 ms、总耗时超过一分钟(1.1m),
// 最后一个没有成功样本所以两项都是 —,ms/s/m 和空值一屏内都能看到。
// lastAt 刻意和尝试数反着来(跑得最多的那个反而最久没打过):面板按最近调用
// 倒序,两种顺序一致的话预览就证明不了排的是时间而不是次数。
// lastModel/lastEffort 也凑齐几种:最长的模型名(布局最容易被挤坏的那个)、
// 显式 max、没发字段的 ''(显示 —),外加一个完全没这两个字段的旧桶。
for (const [name, v] of [
  [NODES[2], { requests: 812, success: 774, rateLimited: 26, timeout: 8, upstreamError: 4, promptTokens: 1_902_441, completionTokens: 664_120, reasoningTokens: 281_004, totalTokens: 2_566_561, cacheReadTokens: 741_233, cacheWriteTokens: 96_410, hasCacheData: true, ttfbMs: 1_099_080, ttfbCount: 774, durationMs: 6_656_400, durationCount: 774, lastAt: Date.now() - 42_000, lastModel: 'deepseek-v4-flash-free', lastEffort: 'max' }],
  [NODES[0], { requests: 418, success: 372, rateLimited: 39, timeout: 5, upstreamError: 2, promptTokens: 742_118, completionTokens: 261_337, reasoningTokens: 108_442, totalTokens: 1_003_455, cacheReadTokens: 88_004, cacheWriteTokens: 12_770, hasCacheData: true, ttfbMs: 1_004_400, ttfbCount: 372, durationMs: 5_282_400, durationCount: 372, lastAt: Date.now() - 5_000, lastModel: 'deepseek-v4-flash-free', lastEffort: 'max' }],
  [NODES[6], { requests: 231, success: 189, rateLimited: 33, timeout: 7, upstreamError: 2, promptTokens: 196_743, completionTokens: 60_984, reasoningTokens: 23_441, totalTokens: 257_727, cacheReadTokens: 0, cacheWriteTokens: 0, hasCacheData: true, ttfbMs: 145_080, ttfbCount: 186, durationMs: 12_852_000, durationCount: 189, lastAt: Date.now() - 900, lastModel: 'north-mini-code-free', lastEffort: 'high' }],
  [NODES[9], { requests: 58, success: 0, rateLimited: 0, timeout: 55, upstreamError: 3, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, hasCacheData: false, ttfbMs: 0, ttfbCount: 0, durationMs: 0, durationCount: 0, lastAt: Date.now() - 3600_000, lastModel: 'big-pickle', lastEffort: '' }],
]) state.usage.byNode[name] = v;

// 调用日志的种子。要点是「同一个节点、同一个模型,连着几次强度不一样」——
// 按节点聚合时这几条会互相覆盖成最后一次,而这张表存在的理由就是把它们拆开。
// 顺序按时间正序(后端是 push 追加的),面板自己倒过来显示。
// 另外凑齐几种边界:强度 '' 显示成 —(没发这个字段,随上游默认)、
// ttfb 为 null(没测到首字节)、最长的模型名(布局最容易被挤坏的那个)。
for (const [ago, node, model, effort, ttfb, ms, pt, ct, rt] of [
  [26 * 60_000, NODES[2], 'deepseek-v4-flash-free', 'high', 1420, 8600, 3182, 741, 402],
  [21 * 60_000, NODES[2], 'deepseek-v4-flash-free', 'max', 1610, 41_200, 3204, 2988, 2611],
  [17 * 60_000, NODES[2], 'deepseek-v4-flash-free', '', 1380, 7900, 3190, 688, 351],
  [12 * 60_000, NODES[0], 'north-mini-code-free', 'high', 890, 5400, 1204, 402, 96],
  [8 * 60_000, NODES[6], 'big-pickle', '', null, 68_400, 8871, 1902, 0],
  [3 * 60_000, NODES[0], 'deepseek-v4-flash-free', 'max', 1720, 39_800, 2044, 3102, 2740],
  [42_000, NODES[2], 'deepseek-v4-flash-free', 'max', 1590, 44_100, 4127, 3311, 2904],
]) {
  state.usage.calls.push({
    at: Date.now() - ago, node, model, effort, ttfb, ms,
    in: pt, out: ct, reasoning: rt,
  });
}

const clients = new Set();

function log(level, msg) {
  const line = { ts: new Date().toISOString(), level, msg };
  state.logs.push(line);
  if (state.logs.length > 500) state.logs.shift();
  const frame = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of clients) res.write(frame);
}

/** 清掉过期冷却,返回仍在冷却的 [{node, remain}](remain 单位:秒) */
function coolingList() {
  const out = [];
  for (const [node, t] of state.cooldowns) {
    const left = COOLDOWN_MS - (Date.now() - t);
    if (left <= 0) state.cooldowns.delete(node);
    else out.push({ node, remain: Math.ceil(left / 1000) });
  }
  return out;
}

function available() {
  return NODES.filter((n) => !state.cooldowns.has(n) && state.delay.get(n) != null);
}

/** 真网关的 rankNodes:延迟低的在前,测不通的不在表里 */
function ranked() {
  return NODES.filter((n) => state.delay.get(n) != null)
    .sort((a, b) => state.delay.get(a) - state.delay.get(b));
}

function excluded() {
  return NODES.filter((n) => state.delay.has(n) && state.delay.get(n) == null);
}

/** 模拟一遍延迟测试:重新摇一次延迟,不通的那两个保持不通 */
async function speedTest() {
  const t0 = Date.now();
  log('info', `[delay] 开始测延迟,${NODES.length} 个节点`);
  await new Promise((r) => setTimeout(r, 1600));
  for (const n of NODES) {
    if (state.delay.get(n) == null) continue;
    state.delay.set(n, 80 + Math.floor(Math.random() * 700));
  }
  state.testedAt = Date.now();
  const alive = ranked();
  const dead = excluded();
  const ms = Date.now() - t0;
  log('ok', `[delay] 测完 ${NODES.length} 个,可用 ${alive.length},最快 ${alive[0]} ${state.delay.get(alive[0])}ms(耗时 ${(ms / 1000).toFixed(1)}s)`);
  if (dead.length) log('warn', `[delay] 剔除 ${dead.length} 个不可用: ${dead.join(', ')}`);
  return { tested: NODES.length, alive: alive.length, dead, fastest: { node: alive[0], delay: state.delay.get(alive[0]) }, ms };
}

/**
 * 模拟一次请求:多数成功,偶发 429 触发冷却。
 *
 * 换节点必须发生在「发请求之前」而不是「429 之后」—— 真网关就是先
 * pickAvailable 再出站。写在 429 分支里的话,等某一刻全员冷却、那次挑选
 * 失败后,current 就再也不会被重新挑一遍,日志会一直拿那个冷却中的节点刷
 * 成功行,而节点池又按规则把它排进冷却区,两边对不上。
 */
function simulate() {
  coolingList();                       // 先清过期项,否则 available() 会把已恢复的节点当成还在冷却

  if (state.cooldowns.has(state.current)) {
    const next = available()[0];
    if (!next) {
      log('error', '[cooldown] 所有节点冷却中,等待恢复');
      return;                          // 不计数:这一发根本没出去
    }
    state.current = next;
    log('info', `[switch] -> ${next}`);
  }

  const u = state.usage.total;
  u.requests++;
  state.usage.lastRequest = Date.now();

  // 节点那一笔单独记:这次真发出去了,不管结果如何
  const nb = (state.usage.byNode[state.current] ??= {
    requests: 0, success: 0, rateLimited: 0, timeout: 0, upstreamError: 0,
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, hasCacheData: false,
    ttfbMs: 0, ttfbCount: 0, durationMs: 0, durationCount: 0, lastAt: 0,
    lastModel: '', lastEffort: '',
  });
  nb.requests++;
  nb.lastAt = Date.now();       // 面板按这个倒序,预览里也得跟着动才看得出重排
  // 真实网关每次尝试都会覆盖这两个,预览不写的话 tick 一下就把行洗成 —。
  // 强度轮着摇:调用日志要证明它能保住每一次的值,而不是像这个桶只留最后一次,
  // 全用同一个强度就试不出来
  nb.lastModel = 'deepseek-v4-flash-free';
  const effort = ['max', 'high', ''][Math.floor(Math.random() * 3)];
  nb.lastEffort = effort;

  if (Math.random() < 0.12) {
    u.fail++;
    nb.rateLimited++;
    state.cooldowns.set(state.current, Date.now());
    log('warn', `[429] ${state.current} 限流,冷却 90s`);
    // 当场换,别把 current 留在冷却节点上等下一 tick —— 那几秒里 /api/nodes
    // 会报一个自己正在冷却的 current,面板读到的是个自相矛盾的状态
    const next = available()[0];
    if (next) {
      state.current = next;
      log('info', `[switch] -> ${next}`);
    }
    return;
  }

  const pt = 900 + Math.floor(Math.random() * 2600);
  const ct = 180 + Math.floor(Math.random() * 900);
  const rt = Math.floor(Math.random() * 500);
  // 开了身份头才给缓存 token —— 这个实验开关想验证的正是这件事,
  // 预览里也让它看得见,不然那张卡的「缓存命中」永远是同一个数
  const cr = state.cfg.opencodeIdentityHeaders ? Math.floor(pt * (0.3 + Math.random() * 0.4)) : 0;
  // 和日志里那个 ms 用同一个数:预览是用来核对面板显示的,日志说 1800ms
  // 而统计另摇一个数的话,对不上的时候分不清是显示错了还是假数据在骗人
  const dt = 620 + Math.floor(Math.random() * 2400);
  nb.success++; nb.promptTokens += pt; nb.completionTokens += ct;
  nb.reasoningTokens += rt; nb.totalTokens += pt + ct;
  nb.cacheReadTokens += cr; nb.cacheWriteTokens += cr ? Math.floor(pt * 0.05) : 0;
  nb.ttfbMs += Math.floor(dt * (0.15 + Math.random() * 0.3)); nb.ttfbCount++;
  nb.durationMs += dt; nb.durationCount++;
  if (state.cfg.opencodeIdentityHeaders) nb.hasCacheData = true;
  u.success++; u.promptTokens += pt; u.completionTokens += ct;
  u.reasoningTokens += rt; u.totalTokens += pt + ct;

  // 每条成功的调用单独记一行,用的是上面那次尝试摇出来的强度
  state.usage.calls.push({
    at: Date.now(), node: state.current, model: nb.lastModel, effort,
    ttfb: Math.floor(dt * (0.15 + Math.random() * 0.3)), ms: dt,
    in: pt, out: ct, reasoning: rt,
  });
  if (state.usage.calls.length > CALL_LOG_LIMIT) {
    state.usage.calls.splice(0, state.usage.calls.length - CALL_LOG_LIMIT);
  }
  log('ok', `[ok] node="${state.current}" ${dt}ms tokens=${pt + ct}`);
}

// ── 路由 ────────────────────────────────────────────────

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

async function handleApi(req, res, path) {
  const m = req.method;

  // 预览本身不鉴权(只绑 127.0.0.1),但登录页要能点通、错误提示也得看得见:
  // 密码固定 preview,填别的就走 401 那条分支
  if (path === '/api/login' && m === 'POST') {
    const b = await readBody(req);
    if (b.pass !== 'preview') return json(res, { error: '用户名或密码不对(预览里密码固定是 preview)' }, 401);
    log('ok', '[auth] admin 已登录');
    return json(res, { ok: true });
  }

  if (path === '/api/logout' && m === 'POST') return json(res, { ok: true });

  if (path === '/api/status' && m === 'GET') {
    return json(res, {
      gatewayRunning: true, gatewayPort: state.cfg.port,
      mihomoRunning: true, mihomoVersion: 'v1.19.13',
      paused: false, demo: true,
      // 真网关这一份是从上游 /zen/v1/models 现拉的(缓存 30 分钟)。
      // 这里写死一份形状一样的,longcat 那个就是「实时」才会出现的
      models: [
        'deepseek-v4-flash-free', 'big-pickle', 'mimo-v2.5-free', 'laguna-s-2.1-free',
        'ling-3.0-flash-free', 'north-mini-code-free', 'nemotron-3-ultra-free', 'longcat-2.0-free',
      ],
      build: state.build,
      buildUrl: `${REPO_URL}/commit/${state.build}`,
      repoUrl: REPO_URL,
      trackRef: 'beta',
    });
  }

  // 检查更新。假数据每点一次翻面:第一次「有新版本」、第二次「已是最新」,
  // 两条 toast 和 hash 徽标的高亮态都能看到
  if (path === '/api/check-update' && m === 'POST') {
    await new Promise((r) => setTimeout(r, 900));
    state.hasUpdate = !state.hasUpdate;
    const latest = state.hasUpdate ? 'c31f0a8' : state.build;
    log('ok', state.hasUpdate
      ? `[update] 有新版本 ${latest}(当前 ${state.build})`
      : `[update] 已是最新 ${state.build}`);
    return json(res, {
      current: state.build, latest, hasUpdate: state.hasUpdate,
      htmlUrl: `${REPO_URL}/commit/${latest}`,
      publishedAt: new Date(Date.now() - 3600_000).toISOString(),
      error: null,
    });
  }

  if (path === '/api/config' && m === 'GET') return json(res, state.cfg);

  if (path === '/api/config' && m === 'POST') {
    const b = await readBody(req);
    if (b.subscriptionUrl !== undefined) state.cfg.subscriptionUrl = String(b.subscriptionUrl);
    if (b.port !== undefined) state.cfg.port = Number(b.port) || state.cfg.port;
    if (b.opencodeIdentityHeaders !== undefined) {
      state.cfg.opencodeIdentityHeaders = b.opencodeIdentityHeaders === true;
      log('info', `[config] OpenCode 请求头${state.cfg.opencodeIdentityHeaders ? '已开启' : '已关闭'}`);
    }
    if (b.subscriptionUpdateHours !== undefined) {
      state.cfg.subscriptionUpdateHours = Number(b.subscriptionUpdateHours) || 0;
      log('info', state.cfg.subscriptionUpdateHours
        ? `[sub-auto] 每 ${state.cfg.subscriptionUpdateHours} 小时自动更新并测速`
        : '[sub-auto] 自动更新已关闭');
    }
    log('info', '[config] 已保存');
    if (b.subscriptionUrl === undefined) {
      return json(res, { ...state.cfg });
    }
    log('ok', `[sub] 刷新成功,${NODES.length} 个节点`);
    // 真网关刷完订阅会顺手测一遍延迟,预览也照做,不然「保存后节点重排」看不到
    const speed = await speedTest();
    return json(res, { ...state.cfg, nodes: NODES.length, speed });
  }

  if (path === '/api/nodes' && m === 'GET') {
    return json(res, {
      nodes: ranked(),
      excluded: excluded(),
      delay: Object.fromEntries(state.delay),
      testedAt: state.testedAt,
      testing: false,
      current: state.current,
      locked: state.current,
      cooldowns: coolingList(),
    });
  }

  if (path === '/api/nodes/test' && m === 'POST') return json(res, await speedTest());

  if (path === '/api/usage' && m === 'GET') return json(res, state.usage);

  if (path === '/api/usage/reset' && m === 'POST') {
    state.usage.total = {
      requests: 0, success: 0, fail: 0,
      promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    };
    state.usage.byDay = {};
    state.usage.byModel = {};
    state.usage.byNode = {};      // 清零把两套口径一起清,只清一套会对不上
    state.usage.calls = [];       // 调用日志同理:留着的话时间线里会横着一段清零前的旧记录
    state.usage.lastRequest = null;
    state.usage.startTime = Date.now();
    log('ok', '[usage] 用量已清零');
    return json(res, state.usage);
  }

  if (path === '/api/regen-key' && m === 'POST') {
    state.cfg.apiKey = 'zen-' + Math.random().toString(16).slice(2, 10);
    log('info', `[config] 新 Key: ${state.cfg.apiKey}`);
    return json(res, { apiKey: state.cfg.apiKey });
  }

  if (path === '/api/restart' && m === 'POST') {
    log('info', '[mihomo] 手动重启...');
    await new Promise((r) => setTimeout(r, 700));
    log('ok', '[mihomo] 已启动');
    return json(res, { ok: true });
  }

  if (path === '/api/reset' && m === 'POST') {
    log('warn', '===== 手动重置开始 =====');
    const n = state.cooldowns.size;
    state.cooldowns.clear();
    state.current = NODES[0];
    await new Promise((r) => setTimeout(r, 700));
    log('ok', `[reset] 清空 ${n} 个冷却记录`);
    log('ok', '===== 手动重置完成 =====');
    speedTest();      // 真网关重置后也会后台测一遍
    return json(res, { ok: true, cleared: n });
  }

  if (path === '/api/logs' && m === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(state.logs)}\n\n`);   // 首帧:历史快照
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  json(res, { error: `Not found: ${m} ${path}` }, 404);
}

async function serveStatic(res, path) {
  // 防目录穿越:归一化后必须仍在 WEB 之内
  const rel = normalize(path === '/' ? 'index.html' : path.slice(1)).replace(/^([.][.][/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/api/')) handleApi(req, res, path).catch(() => json(res, { error: 'internal' }, 500));
  // /login 这条路径和真网关保持一致 —— 预览不鉴权,所以退出登录只是回到这一页
  else serveStatic(res, path === '/login' ? '/login.html' : path);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Ciallo Zen Proxy · UI 预览\n  http://localhost:${PORT}\n\n  演示数据,每 3 秒模拟一次请求。Ctrl+C 退出。\n`);
  log('ok', '[gateway] 监听 127.0.0.1:' + state.cfg.port);
  log('ok', `[mihomo] 已启动,${NODES.length} 个节点`);
  log('info', `[gateway] 免费模型 8 个,客户端选哪个转发哪个`);
});

setInterval(simulate, 3000);
