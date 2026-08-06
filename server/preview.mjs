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
  cfg: { subscriptionUrl: 'https://demo.example.com/subscribe?token=preview', apiKey: 'zen-a1b2c3d4', port: 9527 },
  current: NODES[2],
  cooldowns: new Map(),          // name -> 进入冷却的时间戳
  // 假的实测延迟。故意留两个 null:那是「测过但不通」,面板要把它们
  // 单独标出来而不是静默消失 —— 不然看起来像订阅少了节点。
  delay: new Map(NODES.map((n, i) => [n, i === 4 || i === 9 ? null : 90 + i * 37 + (i % 3) * 24])),
  testedAt: Date.now() - 42_000,
  usage: {
    total: { requests: 1284, success: 1197, fail: 87, promptTokens: 2_841_302, completionTokens: 986_441, reasoningTokens: 412_887, totalTokens: 3_827_743 },
    byDay: {}, byModel: {},
    lastRequest: Date.now() - 4200,
    startTime: Date.now() - 3600_000 * 27,
  },
  logs: [],
};

state.usage.byModel['deepseek-v4-flash-free'] = { requests: 1043, totalTokens: 3_102_884 };
state.usage.byModel['big-pickle'] = { requests: 168, totalTokens: 561_209 };
state.usage.byModel['mimo-v2.5-free'] = { requests: 73, totalTokens: 163_650 };

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

  if (Math.random() < 0.12) {
    u.fail++;
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
  u.success++; u.promptTokens += pt; u.completionTokens += ct;
  u.reasoningTokens += rt; u.totalTokens += pt + ct;
  log('ok', `[ok] node="${state.current}" ${620 + Math.floor(Math.random() * 2400)}ms tokens=${pt + ct}`);
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

  if (path === '/api/status' && m === 'GET') {
    return json(res, {
      gatewayRunning: true, gatewayPort: state.cfg.port,
      mihomoRunning: true, mihomoVersion: 'v1.19.13',
      fixedModel: 'deepseek-v4-flash-free',
      paused: false, demo: true,
    });
  }

  if (path === '/api/config' && m === 'GET') return json(res, state.cfg);

  if (path === '/api/config' && m === 'POST') {
    const b = await readBody(req);
    if (b.subscriptionUrl !== undefined) state.cfg.subscriptionUrl = String(b.subscriptionUrl);
    if (b.port !== undefined) state.cfg.port = Number(b.port) || state.cfg.port;
    log('info', '[config] 已保存');
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
    };
    state.usage.byDay = {};
    state.usage.byModel = {};
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
  else serveStatic(res, path);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Ciallo DS4F Proxy · UI 预览\n  http://localhost:${PORT}\n\n  演示数据,每 3 秒模拟一次请求。Ctrl+C 退出。\n`);
  log('ok', '[gateway] 监听 127.0.0.1:' + state.cfg.port);
  log('ok', `[mihomo] 已启动,${NODES.length} 个节点`);
  log('info', `[gateway] Model: deepseek-v4-flash-free (固定)`);
});

setInterval(simulate, 3000);
