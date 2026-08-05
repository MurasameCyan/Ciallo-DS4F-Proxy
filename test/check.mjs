/**
 * check.mjs —— core.js 自检。node --test 不需要,直接 assert 跑。
 *
 * 只测有分支/有边界的:排序规则、冷却过期、裁剪、掩码、空值兜底。
 * 纯转发的格式化(fmtCount/fmtPercent)不测。
 *
 * 跑:node test/check.mjs
 */

import assert from 'node:assert/strict';
import {
  COOLDOWN_MS, MAX_LOG, fmtUptime, fmtClock, successRate, fmtPercent,
  cooldownDeadline, remainMs, nodeRows, pushLog, maskKey, endpointBase, rankBreakdown,
} from '../web/core.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// ── 成功率 ──────────────────────────────────────────────

t('没请求时成功率是 null,不是 0(避免误报"全挂了")', () => {
  assert.equal(successRate({ requests: 0, success: 0 }), null);
  assert.equal(fmtPercent(null), '—');
  assert.equal(successRate(undefined), null);
});

t('成功率正常计算', () => {
  assert.equal(successRate({ requests: 4, success: 3 }), 0.75);
  assert.equal(fmtPercent(0.75), '75.0%');
});

// ── 时长 ────────────────────────────────────────────────

t('fmtUptime 逐级降到合适单位', () => {
  assert.equal(fmtUptime(45_000), '45 秒');
  assert.equal(fmtUptime(125_000), '2 分 5 秒');
  assert.equal(fmtUptime(3600_000 * 5 + 60_000 * 7), '5 时 7 分');
  assert.equal(fmtUptime(86400_000 * 2 + 3600_000 * 3), '2 天 3 时');
});

t('fmtUptime / fmtClock 吃到坏值不抛', () => {
  assert.equal(fmtUptime(-1), '0 秒');
  assert.equal(fmtUptime(NaN), '0 秒');
  assert.equal(fmtUptime(undefined), '0 秒');
  assert.equal(fmtClock('不是时间'), '--:--:--');
  assert.match(fmtClock('2026-08-06T01:02:03Z'), /^\d\d:\d\d:\d\d$/);
});

// ── 冷却 ────────────────────────────────────────────────

t('服务端秒数折算成本地截止点', () => {
  assert.equal(cooldownDeadline(90, 1000), 1000 + 90_000);
  assert.equal(cooldownDeadline(-5, 1000), 1000, '负数当 0,不能算出过去的截止点');
  assert.equal(remainMs(5000, 1000), 4000);
  assert.equal(remainMs(500, 1000), 0, '已过期夹到 0,不能是负数');
});

// ── 节点排序(核心) ────────────────────────────────────

const NODES = ['A', 'B', 'C', 'D'];

t('在用节点排第一,其余待用保持订阅原序', () => {
  const r = nodeRows({ nodes: NODES, current: 'C', now: 0 });
  assert.deepEqual(r.map((x) => x.name), ['C', 'A', 'B', 'D']);
  assert.equal(r[0].state, 'active');
  assert.equal(r[1].state, 'idle');
});

t('冷却中的排最后,且剩余短的靠前(对齐网关"选剩余最短")', () => {
  const now = 0;
  const r = nodeRows({
    nodes: NODES,
    current: 'A',
    cooldowns: [{ node: 'B', remain: 80 }, { node: 'D', remain: 20 }],
    now,
  });
  assert.deepEqual(r.map((x) => x.name), ['A', 'C', 'D', 'B']);
  assert.equal(r[2].state, 'cooling');
  assert.equal(r[2].remain, 20_000);
});

t('当前节点正在冷却时标 cooling 而不是 active', () => {
  const r = nodeRows({ nodes: NODES, current: 'A', cooldowns: [{ node: 'A', remain: 30 }], now: 0 });
  const a = r.find((x) => x.name === 'A');
  assert.equal(a.state, 'cooling', '被限流的节点不能显示成"在用"');
  assert.equal(r[0].name, 'B', '排头应让给真正可用的');
});

t('冷却已过期的条目直接当可用', () => {
  const r = nodeRows({ nodes: NODES, cooldowns: [{ node: 'B', remain: 0 }], now: 0 });
  assert.equal(r.find((x) => x.name === 'B').state, 'idle');
  assert.equal(r.filter((x) => x.state === 'cooling').length, 0);
});

t('ratio 用于画进度,落在 0..1', () => {
  const r = nodeRows({ nodes: ['A'], cooldowns: [{ node: 'A', remain: 45 }], now: 0 });
  assert.equal(r[0].ratio, 45_000 / COOLDOWN_MS);
});

t('空输入不抛,返回空数组', () => {
  assert.deepEqual(nodeRows(), []);
  assert.deepEqual(nodeRows({ nodes: [] }), []);
  assert.deepEqual(nodeRows({ nodes: ['A'], cooldowns: [null, {}] }).map((x) => x.state), ['idle']);
});

// ── 日志缓冲 ────────────────────────────────────────────

t('日志超上限时裁掉最旧的,长度不超标', () => {
  const buf = [];
  for (let i = 0; i < MAX_LOG + 30; i++) pushLog(buf, { msg: i });
  assert.equal(buf.length, MAX_LOG);
  assert.equal(buf[0].msg, 30, '应保留最新的那批');
  assert.equal(buf.at(-1).msg, MAX_LOG + 29);
});

t('一次灌入远超上限也能裁到位', () => {
  const buf = Array.from({ length: 900 }, (_, i) => ({ msg: i }));
  pushLog(buf, { msg: 'last' }, 10);
  assert.equal(buf.length, 10);
  assert.equal(buf.at(-1).msg, 'last');
});

// ── Key 掩码 ────────────────────────────────────────────

t('掩码保留头尾 4 位,中段不泄漏长度', () => {
  assert.equal(maskKey('zen-a1b2c3d4'), 'zen-••••c3d4');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(null), '');
  assert.equal(maskKey('short'), '•••••', '短 key 全遮,不能露出任何字符');
  const long = maskKey('sk-' + 'x'.repeat(60));
  assert.ok(!long.includes('xxxxxxxxxxxxx'), '不能把原文抄出来');
  assert.ok(long.length < 64, '中段有上限,不按原长铺满');
});

// ── 其他 ────────────────────────────────────────────────

t('endpointBase 端口缺失时回落默认', () => {
  assert.equal(endpointBase(9527, 'localhost'), 'http://localhost:9527/v1');
  assert.equal(endpointBase(null, '1.2.3.4'), 'http://1.2.3.4:9527/v1');
});

t('rankBreakdown 按请求数降序并截断', () => {
  const r = rankBreakdown({ a: { requests: 5 }, b: { requests: 90 }, c: { requests: 12 } }, 2);
  assert.deepEqual(r.map((x) => x.key), ['b', 'c']);
  assert.deepEqual(rankBreakdown(null), []);
});

console.log(`\ncheck.mjs: 全部通过 (${n} 组)\n`);
