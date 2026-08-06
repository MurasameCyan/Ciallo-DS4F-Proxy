#!/usr/bin/env node
// 无头 Chrome 截图 + 布局体检(零依赖,走 CDP)。
//
// 为什么不用 chrome --screenshot:面板挂着一条常驻 SSE 日志流,
// --virtual-time-budget 在有未完成请求时不推进,单命令截图会一直卡死。
// 走 CDP 才能在 load 之后自己决定什么时候截。
//
//   node scripts/shot.mjs                      # 默认三档宽度
//   SIZES=1592x1150 node scripts/shot.mjs      # 只测一档
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET = process.env.URL || 'http://127.0.0.1:5173/';
const OUT = process.env.OUT || '.shots';
const PORT = Number(process.env.CDP_PORT || 9333);
const SIZES = (process.env.SIZES || '1592x1150,1280x1100,760x1500').split(',');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const hit = [process.env.CHROME, ...CANDIDATES].find((p) => p && existsSync(p));
  if (!hit) throw new Error('找不到 Chrome/Edge,用 CHROME=<路径> 指定');
  return hit;
}

// CDP 的最小客户端:send 收请求响应,once 等某个事件。
function cdp(ws) {
  let seq = 0;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(`${m.error.message}`)) : res(m.result);
    } else if (m.method) {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === m.method) { waiters[i].res(m.params); waiters.splice(i, 1); }
      }
    }
  });
  return {
    // sessionId 省略 = 发给浏览器本身;带上 = 发给某个 target(flatten 模式)
    send: (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, sessionId, method, params } : { id, method, params }));
    }),
    once: (method, ms = 20000) => new Promise((res, rej) => {
      waiters.push({ method, res });
      setTimeout(() => rej(new Error(`等 ${method} 超时`)), ms);
    }),
  };
}
// 在页内跑的体检:找横向溢出、越界元素、以及被压成 0 高的容器。
// 返回可序列化的纯数据,CDP 只能带回 JSON。
const AUDIT = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;          // 隐藏元素不算
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;                   // toast 之类贴边的正常
    const id = el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
    if (r.right > vw + 1)  bad.push({ id, why: 'overflow-right', right: Math.round(r.right), vw });
    if (r.left < -1)       bad.push({ id, why: 'overflow-left',  left:  Math.round(r.left) });
    // 表单控件的值比框长是它们的正常工作方式(自己内部滚动),不是布局破了
    const formCtl = /^(input|textarea|select)$/.test(el.tagName.toLowerCase());
    // 省略号截断同理:overflow:hidden + text-overflow:ellipsis 就是"故意裁掉"
    // 的写法(节点名可以任意长,只能裁)。不排除的话每个长节点名都报一条,
    // 真正的布局破损就被淹了。
    const clipsOnPurpose = cs.textOverflow === 'ellipsis' && cs.overflowX === 'hidden';
    if (!formCtl && !clipsOnPurpose && el.scrollWidth > el.clientWidth + 1
        && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
      bad.push({ id, why: 'content-wider-than-box', scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
  }
  return {
    vw,
    docScrollW: de.scrollWidth,
    hasHScroll: de.scrollWidth > vw + 1,
    bad: bad.slice(0, 24),
    cards: [...document.querySelectorAll('main .card')].map((c) => {
      const r = c.getBoundingClientRect();
      const h = c.querySelector('h2, h3');
      return {
        name: (h ? h.textContent : '?').trim(),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    }),
  };
})()`;

async function main() {
  const browser = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'shot-'));
  mkdirSync(OUT, { recursive: true });

  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb',
    '--disable-extensions', '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {          // 等 DevTools 端点起来
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { /* 还没起,继续等 */ }
  }
  if (!wsUrl) { child.kill(); throw new Error('Chrome DevTools 端点没起来'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('连不上 CDP')), { once: true });
  });
  const root = cdp(ws);

  // 每档宽度开一个新 target,互不干扰(避免上一档的 SSE 连接残留)
  const report = [];
  for (const size of SIZES) {
    const [w, h] = size.split('x').map(Number);
    const { targetId } = await root.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: true });

    const s = (method, params) => root.send(method, params, sessionId);

    await s('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Page.navigate', { url: TARGET });

    // 等到 DOM 稳定:轮询直到节点池渲染出来(预览首帧要一次 fetch)
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(250);
      const { result } = await s('Runtime.evaluate', {
        expression: `!!document.querySelector('#nodes .node') || !!document.querySelector('#nodes-empty:not([hidden])')`,
        returnByValue: true,
      });
      ready = result.value === true;
    }
    await sleep(600);                                 // 让过渡动画落定

    const { result: audit } = await s('Runtime.evaluate', {
      expression: AUDIT, returnByValue: true,
    });
    report.push({ size, ready, ...audit.value });

    const { data } = await s('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
    });
    const file = join(OUT, `${w}x${h}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`✓ ${file}`);

    await root.send('Target.closeTarget', { targetId });
  }

  ws.close();
  child.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 有时锁着,不致命 */ }

  // 体检结论
  let fail = false;
  for (const r of report) {
    const flag = r.hasHScroll || r.bad.length ? '✗' : '✓';
    if (r.hasHScroll || r.bad.length) fail = true;
    console.log(`\n${flag} ${r.size}  内容宽 ${r.docScrollW} / 视口 ${r.vw}${r.ready ? '' : '  (数据没加载出来)'}`);
    for (const b of r.bad) console.log(`   ! ${b.why}  ${b.id}  ${JSON.stringify(b)}`);
    for (const c of r.cards) console.log(`   · ${c.name.padEnd(6)} x=${String(c.x).padStart(4)} y=${String(c.y).padStart(4)} ${c.w}×${c.h}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
