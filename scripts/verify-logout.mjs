#!/usr/bin/env node
// 浏览器级别验证登录 / 退出登录这条路(零依赖,走 CDP)。
//
// 为什么要拉浏览器:「点击登出没反应」这个 bug 有两半。服务端那半(页面也认
// Basic,退出后 /login 又被 302 回面板)已经钉在 test/server.mjs 里了;剩下这半
// 只有真浏览器能看见 —— 按钮里套着 <svg>,点击落在子元素上;location.replace
// 之后 cookie 到底还带不带;控制台有没有把 handler 整个抛掉。
//
// 打的是真 server(createApp),不是 preview —— preview 不鉴权,那道门在它身上
// 根本不存在,拿它验等于什么都没验。
//
//   node scripts/verify-logout.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9334);   // 和 shot.mjs 的 9333 错开
const USER = 'verify-user';
const PASS = 'verify-pass-123';

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

// CDP 最小客户端,和 shot.mjs 里那份一样
function cdp(ws) {
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  return {
    send: (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, sessionId, method, params } : { id, method, params }));
    }),
  };
}

/** 起一个真 server。DATA_DIR 指到临时目录,不碰 /data */
async function startServer() {
  const tmp = mkdtempSync(join(tmpdir(), 'verify-logout-data-'));
  process.env.DATA_DIR = tmp;
  process.env.PANEL_USER = USER;
  process.env.PANEL_PASS = PASS;
  delete process.env.SUBSCRIPTION_URL;
  delete process.env.API_KEY;

  const { load } = await import('../server/config.mjs');
  const { Gateway } = await import('../server/gateway.mjs');
  const { createApp } = await import('../server/index.mjs');

  const cfg = load();
  const gateway = new Gateway(cfg, () => {});
  // 不出站拉模型清单:本机没内核,这一步只会卡 5 秒然后失败
  gateway.upstreamGet = async () => { throw new Error('验证脚本不出站'); };

  const app = createApp({ cfg, creds: { user: USER, pass: PASS, generated: false }, gateway });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${app.address().port}`, app, tmp };
}

async function main() {
  const { base, app, tmp } = await startServer();
  const browser = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'verify-logout-'));
  const fail = [];

  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { /* 还没起 */ }
  }
  if (!wsUrl) { child.kill(); throw new Error('Chrome DevTools 端点没起来'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('连不上 CDP')), { once: true });
  });
  const root = cdp(ws);
  const { targetId } = await root.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => root.send(m, p, sessionId);

  // 控制台报错要能看见 —— handler 整个抛掉的话点击就是"没反应"
  const errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '?').join(' '));
    }
  });

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Network.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const at = async (expr) => {
    const { result } = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return result.value;
  };
  /** 等某个表达式变真,最多 wait 毫秒 */
  const until = async (expr, wait = 8000) => {
    for (let i = 0; i * 200 < wait; i++) {
      if (await at(expr) === true) return true;
      await sleep(200);
    }
    return false;
  };
  const goto = async (url) => {
    await s('Page.navigate', { url });
    await sleep(700);
  };

  // ① 没登录时面板被送到登录页
  await goto(`${base}/`);
  const p1 = await at('location.pathname');
  if (p1 !== '/login') fail.push(`没登录访问 / 应该到 /login,实际 ${p1}`);
  if (!await at(`!!document.getElementById('login-form')`)) fail.push('/login 没渲染出登录表单');

  // ② 密码错了要在页面上给出提示,而不是弹浏览器那个框
  await at(`(() => {
    document.getElementById('f-user').value = ${JSON.stringify(USER)};
    document.getElementById('f-pass').value = 'wrong-on-purpose';
    document.getElementById('btn-login').click();
  })()`);
  if (!await until(`!document.getElementById('login-err').hidden`)) {
    fail.push('密码错了页面上没出提示');
  }
  if (await at('location.pathname') !== '/login') fail.push('密码错了不该离开登录页');

  // ③ 正确凭据 → 落到面板,并且数据真的渲染出来了
  await at(`(() => {
    document.getElementById('f-pass').value = ${JSON.stringify(PASS)};
    document.getElementById('btn-login').click();
  })()`);
  if (!await until(`location.pathname === '/'`)) fail.push('凭据对了没跳到面板');
  else if (!await until(`!!document.getElementById('btn-logout')`)) fail.push('面板没渲染出来');
  // 面板上的 API 得真能用(会话 cookie 有效),不然进来也是一片空
  const gotKey = await at(`fetch('/api/config').then(r => r.ok).catch(() => false)`);
  if (gotKey !== true) fail.push('登录后 /api/config 打不通,会话 cookie 没生效');

  // ④ 把浏览器缓存的 Basic 凭据模拟上:老版本弹框收过一次,之后每个请求都自己带。
  //    这正是"退出登录没反应"的成因 —— 服务端删不掉这份缓存,只能不让它开门。
  await s('Network.setExtraHTTPHeaders', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
  });

  // ⑤ 点退出登录。点的是按钮本身,但里头套着 <svg>,真实点击会落在子元素上 ——
  //    所以顺便验一次 elementFromPoint 拿到的东西身上有没有 handler
  const hitsChild = await at(`(() => {
    const b = document.getElementById('btn-logout');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== b && b.contains(hit);
  })()`);
  await s('Runtime.evaluate', { expression: `document.getElementById('btn-logout').click()` });

  if (!await until(`location.pathname === '/login'`)) {
    fail.push(`点了退出登录还在 ${await at('location.pathname')} —— 就是这个 bug`);
  }
  // ⑥ 并且要留在登录页。带着 Basic 再打一次面板,不能被放进去
  await goto(`${base}/`);
  const p2 = await at('location.pathname');
  if (p2 !== '/login') fail.push(`退出后带 Basic 又进了面板(${p2}),那份缓存把门顶开了`);
  // 会话确实作废了:/api/* 上 Basic 仍然认(脚本要用),但 cookie 该没了
  const sidGone = await at(`document.cookie.includes('ciallo_sid') === false`);
  if (sidGone !== true) fail.push('cookie 还在,会话没被清掉');

  ws.close();
  child.kill();
  await new Promise((r) => app.close(r));
  for (const p of [profile, tmp]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows 有时锁着,不致命 */ }
  }

  console.log(`  ${hitsChild ? '点击落在按钮的 <svg> 子元素上(handler 挂在按钮上,冒泡接住)' : '点击直接命中按钮'}`);
  if (errors.length) {
    console.log('\n控制台报错:');
    for (const e of errors.slice(0, 8)) console.log(`   ! ${e}`);
  }
  if (fail.length) {
    console.log('');
    for (const f of fail) console.log(`✗ ${f}`);
    process.exit(1);
  }
  console.log('\n✓ 登录 / 退出登录整条路在真浏览器里通:退出后带着缓存的 Basic 也进不来');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });

