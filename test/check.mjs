/**
 * check.mjs —— core.js 自检。node --test 不需要,直接 assert 跑。
 *
 * 只测有分支/有边界的:排序规则、冷却过期、裁剪、掩码、空值兜底。
 * 纯转发的格式化(fmtCount/fmtPercent)不测。
 *
 * 跑:node test/check.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  COOLDOWN_MS, MAX_LOG, fmtTokens, fmtUptime, fmtClock, successRate, fmtPercent,
  cooldownDeadline, remainMs, nodeRows, pushLog, maskKey, endpointBase, rankBreakdown,
  fmtDelay, delayGrade, fmtAgo, hasNewer, cacheRate, nodeStats, callLog, configPayload, updateHours,
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

// ── 延迟 ────────────────────────────────────────────────

t('延迟原样带出,没测过的是 null 而不是 0', () => {
  const r = nodeRows({ nodes: NODES, delay: { A: 120, B: null, C: 0 }, now: 0 });
  const by = Object.fromEntries(r.map((x) => [x.name, x.latency]));
  assert.equal(by.A, 120);
  assert.equal(by.B, null, '测过但不通 -> null');
  assert.equal(by.C, null, '0ms 是不可能的实测值,当没测过');
  assert.equal(by.D, null, '压根没在 delay 里');
});

t('测不通的节点垫在最底下并标 dead,不参与轮换', () => {
  const r = nodeRows({
    nodes: ['A', 'B'], excluded: ['Z', 'Y'],
    current: 'A', delay: { A: 90, B: 300, Z: null, Y: null }, now: 0,
  });
  assert.deepEqual(r.map((x) => x.name), ['A', 'B', 'Y', 'Z']);
  assert.equal(r[2].state, 'dead');
  assert.equal(r[2].latency, null);
  assert.equal(r.filter((x) => x.state === 'dead').length, 2);
});

t('excluded 里混进还在用的节点时不重复出现', () => {
  // 两次轮询之间后端刚测完速,nodes 和 excluded 可能短暂重叠
  const r = nodeRows({ nodes: ['A', 'B'], excluded: ['B'], now: 0 });
  assert.deepEqual(r.map((x) => x.name), ['A', 'B']);
  assert.equal(r.find((x) => x.name === 'B').state, 'idle');
});

t('后端给的顺序就是优先级,前端不再按延迟重排', () => {
  // 后端排好序发过来(慢的在前是不可能的,但真发生了也得照显示 ——
  // 否则面板顺序和网关实际取用顺序不一致,那一列编号就是错的)
  const r = nodeRows({ nodes: ['slow', 'fast'], delay: { slow: 900, fast: 80 }, now: 0 });
  assert.deepEqual(r.map((x) => x.name), ['slow', 'fast']);
});

t('fmtDelay:秒级换单位,没测过显示破折号', () => {
  assert.equal(fmtDelay(87), '87ms');
  assert.equal(fmtDelay(999), '999ms');
  assert.equal(fmtDelay(1000), '1.0s');
  assert.equal(fmtDelay(2480), '2.5s');
  assert.equal(fmtDelay(59_999), '60.0s');
  assert.equal(fmtDelay(60_000), '1.0m', '推理模型跑满预算时「92.4s」得能自己换成分钟');
  assert.equal(fmtDelay(92_400), '1.5m');
  assert.equal(fmtDelay(null), '—');
  assert.equal(fmtDelay(0), '—', '0ms 不是真实结果');
  assert.equal(fmtDelay('x'), '—');
});

t('delayGrade 分三档,无数据不给档', () => {
  assert.equal(delayGrade(120), 'fast');
  assert.equal(delayGrade(299), 'fast');
  assert.equal(delayGrade(300), 'mid');
  assert.equal(delayGrade(999), 'mid');
  assert.equal(delayGrade(1000), 'slow');
  assert.equal(delayGrade(null), '');
});

t('fmtAgo:没测过时说出来,不显示「0 秒前」', () => {
  const now = 1_000_000;
  assert.equal(fmtAgo(null, now), '还没测过');
  assert.equal(fmtAgo(0, now), '还没测过');
  assert.equal(fmtAgo(now - 5_000, now), '5 秒前测');
  assert.equal(fmtAgo(now - 125_000, now), '2 分钟前测');
  assert.equal(fmtAgo(now - 7200_000, now), '2 小时前测');
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

t('fmtTokens 空值显示 0', () => {
  assert.equal(fmtTokens(undefined), '0');
});

t('endpointBase 原样沿用当前地址,不拼进程端口', () => {
  assert.equal(endpointBase('http://ds4f.example.com'), 'http://ds4f.example.com/v1',
    '反代在 80 上时不能凭空补 :9527,那个地址外面连不上');
  assert.equal(endpointBase('http://localhost:9527'), 'http://localhost:9527/v1');
  assert.equal(endpointBase('https://a.b'), 'https://a.b/v1');
  assert.equal(endpointBase('http://h:8080/'), 'http://h:8080/v1', '末尾斜杠不能变成 //v1');
  assert.equal(endpointBase(''), 'http://localhost:9527/v1', '没 origin 时给个能用的默认');
  assert.equal(endpointBase(null), 'http://localhost:9527/v1');
});

t('rankBreakdown 按请求数降序并截断', () => {
  const r = rankBreakdown({ a: { requests: 5 }, b: { requests: 90 }, c: { requests: 12 } }, 2);
  assert.deepEqual(r.map((x) => x.key), ['b', 'c']);
  assert.deepEqual(rankBreakdown(null), []);
});

t('hasNewer 只在两个 hash 都有且不同时才亮', () => {
  assert.equal(hasNewer('c31f0a8', '9dfba56'), true);
  assert.equal(hasNewer('9dfba56', '9dfba56'), false, '更新完重启后标记要自己消失');
  assert.equal(hasNewer('', '9dfba56'), false, '还没查过就不该亮');
  assert.equal(hasNewer('c31f0a8', ''), false, '本地 hash 未知时新旧无从判断');
});

t('配置提交:只改开关或周期时省略订阅,主动保存时保留订阅以强制刷新', () => {
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/a',
    savedIdentity: false, identity: true, savedUpdateHours: 0, updateHours: 0,
  }), { opencodeIdentityHeaders: true, subscriptionUpdateHours: 0 });
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/a',
    savedIdentity: false, identity: false, savedUpdateHours: 0, updateHours: 6,
  }), { opencodeIdentityHeaders: false, subscriptionUpdateHours: 6 });
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/b',
    savedIdentity: false, identity: false, savedUpdateHours: 0, updateHours: 0,
  }), { subscriptionUrl: 'https://sub.example/b', opencodeIdentityHeaders: false, subscriptionUpdateHours: 0 });
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/a',
    savedIdentity: false, identity: false, savedUpdateHours: 0, updateHours: 0,
  }), { subscriptionUrl: 'https://sub.example/a', opencodeIdentityHeaders: false, subscriptionUpdateHours: 0 });
});

t('自动更新小时数只接受 0 或正整数', () => {
  assert.equal(updateHours(''), 0);
  assert.equal(updateHours('0'), 0);
  assert.equal(updateHours('6'), 6);
  assert.equal(updateHours('1.5'), null);
  assert.equal(updateHours('-1'), null);
  assert.equal(updateHours('8761'), null);
});

// ── 节点统计 ────────────────────────────────────────────

t('缓存命中率:上游没给缓存字段或没有分母时显示无数据', () => {
  // 0% 会被读成「试过、一次没命中」,而真相可能是上游根本没报这个数
  assert.equal(cacheRate({ promptTokens: 100, cacheReadTokens: 0, hasCacheData: false }), null);
  assert.equal(cacheRate({ promptTokens: 0, cacheReadTokens: 0, hasCacheData: true }), null);
  assert.equal(cacheRate(undefined), null);
  assert.equal(fmtPercent(cacheRate({ promptTokens: 100, hasCacheData: false })), '—');
  assert.equal(cacheRate({ promptTokens: 100, cacheReadTokens: 0, hasCacheData: true }), 0,
    '明确收到 cached_tokens:0 才是真的 0%');
  assert.equal(cacheRate({ promptTokens: 200, cacheReadTokens: 50, hasCacheData: true }), 0.25);
});

t('nodeStats 最近调用的排最上面', () => {
  const { rows } = nodeStats({
    busy: { requests: 400, success: 400, lastAt: 1_000 },
    fresh: { requests: 2, success: 2, lastAt: 9_000 },
    mid: { requests: 40, success: 40, lastAt: 5_000 },
  });
  assert.deepEqual(rows.map((r) => r.name), ['fresh', 'mid', 'busy'],
    '刚打过的节点在最上面 —— 跑得多不代表现在还在用');
});

t('nodeStats 没有 lastAt 的旧桶垫底,同分按尝试数再按名字稳定排', () => {
  const { rows } = nodeStats({
    B: { requests: 10, success: 10 },
    A: { requests: 10, success: 3 },
    C: { requests: 40, success: 40 },
    now: { requests: 1, success: 1, lastAt: 123 },
  });
  assert.deepEqual(rows.map((r) => r.name), ['now', 'C', 'A', 'B'],
    '升级前的桶没有时间戳,只能退回原来的次序,且不能盖在有时间戳的前面');
});

t('nodeStats 跳过一次都没试过的节点', () => {
  const { rows, totals } = nodeStats({ A: { requests: 0 }, B: { requests: 2, success: 1, timeout: 1 } });
  assert.deepEqual(rows.map((r) => r.name), ['B'], '零尝试的节点不占一行');
  assert.equal(totals.requests, 2);
  assert.equal(totals.timeout, 1);
});

t('nodeStats 带出最近一次的模型和思考强度,旧桶缺字段归一成空串', () => {
  const { rows } = nodeStats({
    A: { requests: 1, success: 1, lastAt: 2, lastModel: ' deepseek-v4-flash-free ', lastEffort: ' max ' },
    B: { requests: 1, success: 1, lastAt: 1 },   // 加这两个字段之前落盘的桶
  });
  const [a, b] = rows;
  // 两头空格来自落盘数据,渲染前就该修掉,否则面板上是「模型  ds4f 」
  assert.equal(a.lastModel, 'deepseek-v4-flash-free');
  assert.equal(a.lastEffort, 'max');
  // 旧桶不能变成 'undefined' 字符串 —— 前端靠 || '—' 兜底,那要求这里是空串
  assert.equal(b.lastModel, '');
  assert.equal(b.lastEffort, '');
});

t('nodeStats 合计只加四类结果和尝试数,token 不进合计', () => {
  const { totals } = nodeStats({
    A: { requests: 3, success: 1, rateLimited: 1, timeout: 1, promptTokens: 900 },
    B: { requests: 2, success: 1, upstreamError: 1, promptTokens: 100 },
  });
  assert.deepEqual(totals, { requests: 5, success: 2, rateLimited: 1, timeout: 1, upstreamError: 1 });
});

t('nodeStats 缺字段当 0,坏值不传染成 NaN', () => {
  // 旧 usage.json 里的桶可能没有 cacheReadTokens 这类后加的字段
  const { rows } = nodeStats({ A: {
    requests: 4, success: 3, promptTokens: 200, cacheReadTokens: 50, hasCacheData: true,
  } });
  const r = rows[0];
  assert.equal(r.upstreamError, 0);
  assert.equal(r.cacheWriteTokens, 0);
  assert.equal(r.rate, 0.75);
  assert.equal(r.cache, 0.25);
  assert.deepEqual(nodeStats(null), {
    rows: [], totals: { requests: 0, success: 0, rateLimited: 0, timeout: 0, upstreamError: 0 },
    ttfb: null, duration: null,
  });
});

t('nodeStats 保留缓存字段存在性,兼容旧桶里的非零缓存', () => {
  const explicitZero = nodeStats({ A: {
    requests: 1, promptTokens: 100, cacheReadTokens: 0, hasCacheData: true,
  } }).rows[0];
  assert.equal(explicitZero.cache, 0, '上游明确返回 0 时面板应显示 0%');

  const legacy = nodeStats({ B: {
    requests: 1, promptTokens: 100, cacheReadTokens: 25,
  } }).rows[0];
  assert.equal(legacy.cache, 0.25, '旧桶的非零缓存读数本身足以证明上游报过数据');
});

t('nodeStats 耗时按样本数加权,不是对各节点的平均再平均', () => {
  const { rows, ttfb, duration } = nodeStats({
    // 跑了 100 次的快节点和跑了 1 次的慢节点:等权平均会算出 ~2.5s,
    // 而实际经历过的平均值贴近 100ms 那一侧
    fast: { requests: 100, success: 100, ttfbMs: 10_000, ttfbCount: 100, durationMs: 50_000, durationCount: 100 },
    slow: { requests: 1, success: 1, ttfbMs: 5_000, ttfbCount: 1, durationMs: 9_000, durationCount: 1 },
  });
  assert.equal(rows.find((r) => r.name === 'fast').ttfb, 100);
  assert.equal(rows.find((r) => r.name === 'slow').ttfb, 5_000);
  assert.equal(ttfb, 15_000 / 101, '合计应是总和除以总样本数');
  assert.equal(duration, 59_000 / 101);
});

t('nodeStats 没有成功样本时耗时是 null 而不是 0', () => {
  // 一直超时的节点:显示 0ms 等于断言「零延迟」,而真相是无从得知
  const { rows, ttfb, duration } = nodeStats({ A: { requests: 5, timeout: 5 } });
  assert.equal(rows[0].ttfb, null);
  assert.equal(rows[0].duration, null);
  assert.equal(fmtDelay(rows[0].duration), '—');
  assert.equal(ttfb, null);
  assert.equal(duration, null);
});

// ── 调用日志 ────────────────────────────────────────────

t('callLog 逐条保留同一节点的不同强度,不像聚合桶只剩最后一次', () => {
  // 这条就是这张表存在的理由:同一个节点连着跑三个档位,按节点聚合只留得下 ''
  const { rows } = callLog([
    { at: 1, node: 'A', model: 'ds4f', effort: 'high' },
    { at: 2, node: 'A', model: 'ds4f', effort: 'max' },
    { at: 3, node: 'A', model: 'ds4f', effort: '' },
  ]);
  assert.deepEqual(rows.map((r) => r.effort), ['', 'max', 'high'], '最近的排最前');
});

t('callLog 用数组顺序倒排,同一毫秒内也保真实先后', () => {
  // 按 at 排序会把同毫秒的两条打乱;后端是 push 追加的,数组本身就是时间序
  const { rows } = callLog([
    { at: 5, node: 'first' }, { at: 5, node: 'second' }, { at: 5, node: 'third' },
  ]);
  assert.deepEqual(rows.map((r) => r.node), ['third', 'second', 'first']);
});

t('callLog 的 ttfb 分清 null 和 0,坏值不传染成 NaN', () => {
  const { rows } = callLog([
    { at: 1, node: 'A', ttfb: 0, ms: 0 },
    { at: 2, node: 'B', ttfb: null, ms: null },
    { at: 3, node: 'C', ttfb: 'oops', ms: 'oops' },
    { at: 4, node: 'D', ttfb: 1200, ms: 3400 },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.node, r]));
  // 测不到首字节和「零延迟」不是一回事,两者都显示 —,但 ms=0 是个真实的数
  assert.equal(by.A.ttfb, null, 'ttfb 为 0 等于没测到');
  assert.equal(by.A.ms, 0, 'ms 为 0 是真实值,保留');
  assert.equal(by.B.ttfb, null);
  assert.equal(by.C.ttfb, null);
  assert.equal(by.C.ms, null, '坏值归一成 null,不能变 NaN');
  assert.equal(fmtDelay(by.C.ms), '—');
  assert.equal(by.D.ttfb, 1200);
});

t('callLog 平均值按有样本的条数算,推理 token 不进 total', () => {
  const { rows, tokens, ttfb, duration } = callLog([
    { at: 1, node: 'A', in: 100, out: 20, reasoning: 500, ttfb: 1000, ms: 4000 },
    { at: 2, node: 'B', in: 200, out: 30, reasoning: 0 },   // 没有耗时样本
  ]);
  assert.equal(rows[1].total, 120, 'total 只算入+出 —— 推理已经含在出里了');
  assert.equal(tokens, 350);
  assert.equal(ttfb, 1000, '分母是有样本的那一条,不是两条');
  assert.equal(duration, 4000);
});

t('callLog 修掉两头空格,坏条目直接跳过', () => {
  const { rows } = callLog([
    null, 'nope', 42,
    { at: 1, node: ' 🇭🇰 香港 01 ', model: ' ds4f ', effort: ' max ' },
  ]);
  assert.equal(rows.length, 1, '坏条目不占一行');
  // 空格来自落盘数据,渲染前就该修掉,否则面板上是「模型  ds4f 」
  assert.equal(rows[0].node, '🇭🇰 香港 01');
  assert.equal(rows[0].model, 'ds4f');
  assert.equal(rows[0].effort, 'max');
});

t('callLog 没有数据时给空表而不是崩', () => {
  for (const bad of [null, undefined, {}, 'x']) {
    assert.deepEqual(callLog(bad), { rows: [], tokens: 0, ttfb: null, duration: null });
  }
});

t('调用日志标题显示平均首字与平均耗时,明细显示单次耗时', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /平均首字\s*\$\{\s*fmtDelay\s*\(\s*ttfb\s*\)\s*\}/);
  assert.match(app, /平均耗时\s*\$\{\s*fmtDelay\s*\(\s*duration\s*\)\s*\}/);
  assert.match(app, /'首字',\s*fmtDelay\(r\.ttfb\)/);
  assert.match(app, /'耗时',\s*fmtDelay\(r\.ms\)/);
});

t('调用日志用「限流」「错误」而不是 429 和上游错误,且标明是累计口径', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const fn = app.match(/function renderCallLog\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(fn, '应能定位 renderCallLog');
  assert.match(fn, /累计限流 \$\{fmtCount\(totals\.rateLimited\)\}/,
    '失败数是开机至今的总数,不加「累计」会被当成这几条里的失败数');
  assert.match(fn, /错误 \$\{fmtCount\(totals\.upstreamError\)\}/);
  assert.match(fn, /最近 \$\{fmtCount\(rows\.length\)\} 条/, '逐条那段要标明只是最近一批');
  assert.doesNotMatch(fn, /'?429/, '调用日志里不出现 429 字样');
  assert.doesNotMatch(fn, /上游错误/);
});

t('Token 消耗显示格式化后的缓存读写明细', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(app, /缓存读\s*\$\{\s*fmtTokens\s*\(\s*t\.cacheReadTokens\s*\)\s*\}/);
  assert.match(app, /缓存写\s*\$\{\s*fmtTokens\s*\(\s*t\.cacheWriteTokens\s*\)\s*\}/);
  assert.ok(html.includes('缓存读 — · 缓存写 —'));
});

t('调用日志使用默认关闭且结构完整的原生折叠', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const details = html.match(/<details\b[^>]*class="card span3"[^>]*>[\s\S]*?<\/details>/)?.[0] || '';
  const opening = details.match(/^<details\b[^>]*>/)?.[0] || '';
  const summary = details.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] || '';
  const summaryBody = summary.match(/^<summary\b[^>]*>([\s\S]*)<\/summary>$/)?.[1] || '';
  const body = details.slice(details.indexOf(summary) + summary.length);

  assert.ok(details, '应存在调用日志 details');
  assert.doesNotMatch(opening, /\sopen(?:\s|=|>)/, '调用日志默认应折叠');
  assert.equal(summaryBody.match(/<h2\b/g)?.length, 1, 'summary 内应只有一个 heading');
  assert.match(summaryBody, /^\s*<h2\b[^>]*id="h-nstat"[^>]*>[\s\S]*?<\/h2>\s*$/,
    'summary 的唯一顶层内容应为调用日志 heading');
  assert.match(summary, /id="nstat-sum"/, '动态合计应位于 summary 内');
  assert.doesNotMatch(summary, /id="(?:nstats|nstat-empty)"/, '折叠正文不应混入 summary');
  assert.match(body, /id="nstats"/, '逐条明细应位于 summary 之后的 details 正文');
  assert.match(body, /id="nstat-empty"/, '空态应位于 summary 之后的 details 正文');
});

t('调用日志卡标题就叫「调用日志」', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<span class="nstat-title">调用日志<\/span>/);
  // 「节点统计」是按节点聚合的旧口径,同一节点只留得下最近一次的模型和强度;
  // 名字留着会让人以为展开还是那张表
  assert.ok(!html.includes('节点统计'), '旧标题不该残留');
});

t('调用日志合计不显示请求级与尝试级口径说明', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(!app.includes('一次客户端请求换几个节点就记几笔'));
  assert.ok(!app.includes('故大于顶部请求总数'));
  // HTML 里那份是渲染前占位,写死文案会在首帧闪出来,所以也不能留
  assert.ok(!html.includes('各记一笔'), '首帧占位不能写死口径说明');
  assert.match(html, /id="nstat-sum"[^>]*>\s*<\/span>/, '合计占位应为空,由 JS 填充');
});

t('调用日志限高内部滚动,滚动条隐藏但键盘可滚', () => {
  const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const rule = css.match(/^\.nstats\s*\{([^}]*)\}/m)?.[1] || '';

  assert.match(rule, /max-height:/, '不限高的话 200 行会把页面拽到十几屏');
  assert.match(rule, /overflow-y:\s*auto/);
  assert.match(rule, /scrollbar-width:\s*none/, 'Firefox 侧要关滚动条');
  assert.match(css, /\.nstats::-webkit-scrollbar\s*\{[^}]*display:\s*none/,
    'WebKit/Blink 不认 scrollbar-width,得单独关');
  // 藏了滚动条,鼠标之外的可供性就全靠这个:不可聚焦的滚动容器键盘滚不动
  const ul = html.match(/<ul\b[^>]*class="nstats"[^>]*>/)?.[0] || '';
  assert.match(ul, /tabindex="0"/, '隐藏滚动条的滚动区必须可聚焦');

  // 轮询每 2 秒重建一次列表,不存回 scrollTop 就会把人弹回顶部
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const fn = app.match(/function renderCallLog\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /const top = ul\.scrollTop/, '重建前应记下滚动位置');
  assert.match(fn, /ul\.scrollTop = top/, '重建后应还原滚动位置');
});

t('根元素常驻滚动条槽,展开调用日志不横向位移', () => {
  const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  // 槽必须挂在滚动容器(视口 = 根元素)上,挂到 body 上不起作用
  const html = css.match(/^html\s*\{([^}]*)\}/m)?.[1] || '';
  assert.match(html, /scrollbar-gutter:\s*stable/, '根元素应预留滚动条槽');
});

t('OpenCode 请求头开启状态使用绿色标签', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const label = html.match(/<label\b[^>]*for="f-identity"[^>]*>([\s\S]*?)<\/label>/)?.[1] || '';
  const checked = css.match(/\.chk\.toggle input:checked ~ \.tag\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(label, /<span>OpenCode 请求头<\/span>/);
  assert.doesNotMatch(label, /OpenCode 身份头/);
  assert.match(app, /checked\s*\?\s*'开启'\s*:\s*'关闭'/);
  assert.doesNotMatch(app, /checked\s*\?\s*'实验中'/);
  assert.match(checked, /color:\s*var\(--mint-dim\)/);
  assert.match(checked, /border-color:[^;]*var\(--mint\)/);
  assert.ok(!html.includes('实验:出站补一组 OpenCode CLI 的身份头'), '指定说明文本应移除');
});

t('OpenCode 请求头开关排在「保存并应用」下方', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const form = html.match(/<form\b[^>]*id="cfg-form"[^>]*>([\s\S]*?)<\/form>/)?.[1] || '';
  const save = form.indexOf('id="btn-save"');
  const idt = form.indexOf('for="f-identity"');

  assert.ok(save >= 0 && idt >= 0, '开关和保存按钮都应在配置表单内');
  assert.ok(idt > save, '开关应位于保存按钮之后');
});

t('配置卡提供小时制自动更新订阅输入', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const field = html.match(/<label\b[^>]*>[\s\S]*?自动更新订阅[\s\S]*?<\/label>/)?.[0] || '';
  assert.match(field, /for="f-sub-hours"|id="f-sub-hours"/);
  assert.match(field, /type="number"/);
  assert.match(field, /min="0"/);
  assert.match(field, /step="1"/);
  assert.match(field, /小时/);
});

console.log(`\ncheck.mjs: 全部通过 (${n} 组)\n`);
