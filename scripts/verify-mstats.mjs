#!/usr/bin/env node
// 「模型统计」那格的限高滚动自检。
//
// 为什么单独一个脚本:scripts/shot.mjs 那份布局体检只查**横向**溢出
// (scrollWidth > clientWidth),而这次改的是**纵向**限高 —— 它按设计就该
// scrollHeight > clientHeight,那份审计既报不出问题也验不出正确。
//
// 验四件事,任一不成立就非零退出:
//   1. 露出来的正好 5 行(高度 ≈ 5 行,不是 11 行全露也不是压成 3 行)
//   2. 真的能滚(scrollTop 推得动,且到得了底)
//   3. 没有可见滚动条(容器不占横向空间给条 + 计算样式两处都关掉了)
//   4. 溢出时容器可聚焦(滚动条藏了,键盘得有别的路)
//
//   node scripts/verify-mstats.mjs        # 需要预览服务器在 5173
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const TARGET = process.env.URL || 'http://127.0.0.1:5173/';
const PORT = Number(process.env.CDP_PORT || 9334);
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = [process.env.CHROME, ...CANDIDATES].find((p) => p && existsSync(p));
if (!browser) { console.error('找不到 Chrome/Edge,用 CHROME=<路径> 指定'); process.exit(2); }

const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1592,1150', TARGET,
], { stdio: 'ignore' });

try {
  // 等 CDP 起来
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) throw new Error('CDP 没起来');

  // WebSocket 是 Node 22+ 内置的,不用装依赖
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { sock.onopen = ok; sock.onerror = no; });
  let seq = 0;
  const pending = new Map();
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    sock.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await sleep(2500);   // 让面板轮一次拿到 usage

  const expr = `(() => {
    const ul = document.getElementById('s-models');
    if (!ul) return { err: '找不到 #s-models' };
    const cs = getComputedStyle(ul);
    const rows = ul.children.length;
    const li = ul.querySelector('li');
    const lineH = li ? li.getBoundingClientRect().height : 0;
    const gap = parseFloat(cs.rowGap) || 0;
    const want5 = 5 * lineH + 4 * gap;
    // 能滚多少
    const before = ul.scrollTop;
    ul.scrollTop = 9999;
    const maxTop = ul.scrollTop;
    ul.scrollTop = before;
    return {
      rows, lineH, gap,
      clientH: ul.clientHeight, scrollH: ul.scrollHeight,
      want5,
      overflows: ul.scrollHeight > ul.clientHeight + 1,
      canScroll: maxTop > 0,
      reachesEnd: Math.abs(maxTop - (ul.scrollHeight - ul.clientHeight)) <= 1,
      overflowY: cs.overflowY,
      sbWidth: cs.scrollbarWidth,
      // 藏了条的话,内容区宽度应当等于边框盒宽度(没被条吃掉)
      barTakesSpace: ul.offsetWidth - ul.clientWidth > 1,
      tabindex: ul.getAttribute('tabindex'),
      role: ul.getAttribute('role'),
    };
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r?.result?.result?.value;
  if (!v || v.err) { console.error('探测失败:', v?.err ?? JSON.stringify(r)); process.exit(2); }

  const fails = [];
  console.log(`模型统计格: ${v.rows} 行, 行高 ${v.lineH.toFixed(1)}px, gap ${v.gap}px`);
  console.log(`  可见高 ${v.clientH}px / 内容高 ${v.scrollH}px  (5 行应为 ≈${v.want5.toFixed(1)}px)`);
  console.log(`  overflowY=${v.overflowY} scrollbarWidth=${v.sbWidth} 条占宽=${v.barTakesSpace}`);
  console.log(`  溢出=${v.overflows} 可滚=${v.canScroll} 到底=${v.reachesEnd} tabindex=${v.tabindex} role=${v.role}`);

  if (v.rows <= 5) {
    // 不足 5 行时限高那条路根本没被执行到,这时候打 ✓ 是假绿灯 —— 它会让
    // 「预览数据被改回三四条」这种回归悄悄溜过去。所以直接判失败,
    // 让人去补预览数据,而不是以为验过了。
    fails.push(`只有 ${v.rows} 行,不足 5 行 —— 限高滚动没被验到(补 server/preview.mjs 的 byModel 到 6 条以上)`);
    if (v.tabindex !== null) fails.push('不溢出却加了 tabindex,白占一个 Tab 停留点');
  } else {
    // 1. 高度 ≈ 5 行(容一点亚像素和 margin)
    if (Math.abs(v.clientH - v.want5) > 3) {
      fails.push(`可见高 ${v.clientH}px 不等于 5 行的 ${v.want5.toFixed(1)}px`);
    }
    // 2. 真能滚且到得了底
    if (!v.canScroll) fails.push('限了高却滚不动');
    if (!v.reachesEnd) fails.push('滚不到底,末尾几行看不到');
    // 3. 没有可见滚动条
    if (v.barTakesSpace) fails.push('滚动条占了横向空间,说明没藏干净');
    // 4. 可聚焦
    if (v.tabindex !== '0') fails.push('溢出了但没有 tabindex,键盘滚不动');
    if (!v.role) fails.push('可聚焦容器缺 role,读屏念不出这是什么');
  }

  if (fails.length) {
    console.error('\n✗ ' + fails.length + ' 项不通过:');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n✓ 限高 5 行 / 可滚到底 / 无可见滚动条 / 键盘可达');
} finally {
  proc.kill();
}
