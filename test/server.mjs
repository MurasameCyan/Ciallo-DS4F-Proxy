/**
 * server.mjs —— 后端自检。
 *
 * 本机没有 Docker,镜像跑不起来,所以这里尽量把"不靠容器就能验的"都验掉:
 * 冷却状态机、mihomo 配置生成、登录/会话/Basic 鉴权、CONNECT 隧道、以及把真
 * server 拉到临时端口上打一遍路由和鉴权。
 *
 * CONNECT 那组是重点 —— 它是原 desktop-app 那个"proxy 选项不存在"的 bug
 * 的回归测试:用一个假代理确认我们真的发了 CONNECT 并复用了返回的连接。
 *
 * 跑:node test/server.mjs
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.mjs 在模块加载时就定死了 DATA_DIR,所以得先设环境变量再动态 import
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-test-'));
process.env.DATA_DIR = TMP;
process.env.PANEL_PASS = 'test-pass';
process.env.PANEL_USER = 'tester';
// 钉死构建标识:不设的话 build.mjs 会去问 git(本机)或读 GITHUB_SHA(CI),
// 两边算出来的 hash 不一样,断言就没法写死
process.env.GIT_COMMIT = 'a'.repeat(40);
delete process.env.SUBSCRIPTION_URL;
delete process.env.API_KEY;

const {
  NodeCooldown, UsageTracker, Gateway, COOLDOWN_MS, FREE_MODELS, pickFreeModels,
  identityHeaders, OPENAI, ANTHROPIC, RESPONSES, readUsage, CALL_LOG_LIMIT, REQUEST_DEADLINE_MS, budgetFor, silentFor,
} = await import('../server/gateway.mjs');
const { buildMihomoYaml, load, genApiKey } = await import('../server/config.mjs');
const { parseBasic, safeEqual, resolveCredentials, matches, readCookie, Sessions, FailWindow } = await import('../server/auth.mjs');
const { connectTunnel } = await import('../server/proxy.mjs');
const { shortSha, buildId, buildInfo, checkUpdate } = await import('../server/build.mjs');
const indexMod = await import('../server/index.mjs');
const { createApp, createSubscriptionUpdater } = indexMod;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// ── 冷却状态机 ──────────────────────────────────────────

const NODES = ['A', 'B', 'C'];

await t('429 的节点进冷却,pickAvailable 跳过它', () => {
  const c = new NodeCooldown();
  c.mark429('A', 'default');
  assert.equal(c.isCooling('A', 'default'), true);
  assert.equal(c.pickAvailable(NODES, 'default'), 'B');
  assert.equal(c.pickAvailable(NODES, 'default', new Set(['B'])), 'C');
});

await t('不同供应商组独立冷却', () => {
  const c = new NodeCooldown();
  c.mark429('A', 'deepseek');
  assert.equal(c.isCooling('A', 'deepseek'), true);
  assert.equal(c.isCooling('A', 'nemotron'), false);
  assert.equal(c.pickAvailable(NODES, 'deepseek'), 'B');
  assert.equal(c.pickAvailable(NODES, 'nemotron'), 'A');
});

await t('冷却过期后自动放行,不用等谁来清', () => {
  const c = new NodeCooldown();
  c.cooldowns.set('A:default', { until: Date.now() - COOLDOWN_MS - 1, retryAfter: null });
  assert.equal(c.isCooling('A', 'default'), false);
  assert.equal(c.cooldowns.has('A:default'), false, '过期项应就地删掉,否则 summary 会一直带着它');
  assert.equal(c.pickAvailable(NODES, 'default'), 'A');
});

await t('全员冷却时 soonest 给出剩余最短的那个', () => {
  const c = new NodeCooldown();
  // 用绝对剩余量构造,只看相对关系(B<C<A),不绑死 COOLDOWN_MS 的具体值
  c.cooldowns.set('A:default', { until: Date.now() + 290_000, retryAfter: null });   // 剩 290s
  c.cooldowns.set('B:default', { until: Date.now() + 220_000, retryAfter: null });   // 剩 220s(最短)
  c.cooldowns.set('C:default', { until: Date.now() + 260_000, retryAfter: null });   // 剩 260s
  assert.equal(c.pickAvailable(NODES, 'default'), null);
  assert.equal(c.soonest(NODES, 'default').node, 'B');
  assert.equal(c.soonest([], 'default'), null, '没节点时不能返回半个对象');
});

await t('summary 的 remain 是秒,且不含已过期项', () => {
  const c = new NodeCooldown();
  c.mark429('A', 'default');
  c.cooldowns.set('B:default', { until: Date.now() - COOLDOWN_MS - 1, retryAfter: null });
  const s = c.summary();
  assert.equal(s.length, 1);
  assert.equal(s[0].node, 'A');
  assert.ok(s[0].remain > 55 && s[0].remain <= 60, `remain 应是秒级 60 左右,得到 ${s[0].remain}`);
});

await t('Retry-After 覆盖默认冷却时长', () => {
  const c = new NodeCooldown();
  c.mark429('A', 'default', 30);  // 30s
  const entry = c.cooldowns.get('A:default');
  const expected = Date.now() + 30_000;
  assert.ok(Math.abs(entry.until - expected) < 100, `应是 now+30s,差了 ${entry.until - expected}ms`);
  assert.equal(entry.retryAfter, 30);
});

await t('无 Retry-After 时兜底冷却 60 秒(不是 5 分钟)', () => {
  const c = new NodeCooldown();
  c.mark429('A', 'default');   // 不带 Retry-After,走兜底
  const entry = c.cooldowns.get('A:default');
  assert.equal(COOLDOWN_MS, 60 * 1000, '无 Retry-After 的兜底应为 60 秒');
  assert.ok(Math.abs(entry.until - (Date.now() + COOLDOWN_MS)) < 100,
    `应是 now+COOLDOWN_MS,差了 ${entry.until - (Date.now() + COOLDOWN_MS)}ms`);
  assert.equal(entry.retryAfter, null, '兜底不该伪造一个 Retry-After 数值');
});

await t('冷却过期即删,但 lastMarked 记着最近限流时刻(供 rankNodes 排队尾)', () => {
  const c = new NodeCooldown();
  c.mark429('A', 'default');
  c.cooldowns.delete('A:default');    // 模拟解冻后过期项被清
  assert.equal(c.isCooling('A', 'default'), false, '解冻了就不算在冷却');
  assert.ok(c.recentMark('A') > 0, '但 lastMarked 记得它刚限流过,好让它排到队尾');
  assert.equal(c.recentMark('Z'), 0, '没限流过的是 0,享受最前优先级');
  c.clear('A', 'default');
  assert.equal(c.recentMark('A'), 0, '成功(clear)后归零,恢复正常优先级');
});

await t('clearAll 返回清掉的个数(面板要显示)', () => {
  const c = new NodeCooldown();
  c.mark429('A', 'default'); c.mark429('B', 'nemotron');
  assert.equal(c.clearAll(), 2);
  assert.equal(c.cooldowns.size, 0);
});

// ── 用量统计 ────────────────────────────────────────────

await t('用量三个维度一起涨,reasoning 和缓存 token 从嵌套字段取', () => {
  const f = path.join(TMP, 'u1.json');
  const u = new UsageTracker(f, () => {});
  u.record('m1', {
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    completion_tokens_details: { reasoning_tokens: 3 },
    prompt_tokens_details: { cached_tokens: 4 },
  }, true);
  u.record('m1', null, false);
  const d = u.getStats();
  assert.equal(d.total.requests, 2);
  assert.equal(d.total.success, 1);
  assert.equal(d.total.fail, 1);
  assert.equal(d.total.reasoningTokens, 3);
  assert.equal(d.total.cacheReadTokens, 4);
  assert.equal(d.byModel.m1.cacheReadTokens, 4);
  assert.equal(d.byModel.m1.requests, 2);
  assert.equal(Object.values(d.byDay)[0].totalTokens, 15);
  assert.ok(fs.existsSync(f), '应落盘,重启不丢');
});

await t('用量文件坏了不抛,当空账开始', () => {
  const f = path.join(TMP, 'u2.json');
  fs.writeFileSync(f, '{ 这不是 json');
  const u = new UsageTracker(f, () => {});
  assert.equal(u.getStats().total.requests, 0);
});

await t('reset 把三个维度一起清空,并且落盘', () => {
  const f = path.join(TMP, 'u3.json');
  const u = new UsageTracker(f, () => {});
  u.record('m1', { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 }, true);
  const t0 = u.getStats().startTime;
  u.reset();
  const d = u.getStats();
  assert.equal(d.total.requests, 0);
  assert.equal(d.total.totalTokens, 0);
  assert.deepEqual(d.byModel, {}, '按模型的明细也要清,不然成功率算不回来');
  assert.deepEqual(d.byDay, {});
  assert.equal(d.lastRequest, null);
  assert.ok(d.startTime >= t0, '运行时长从清零那一刻重算');
  // 重新读一遍文件:清零必须落盘,否则重启一次数字又回来了
  assert.equal(new UsageTracker(f, () => {}).getStats().total.requests, 0);
});

// ── 节点尝试口径(byNode)────────────────────────────────

await t('recordAttempt 按结果分类,四类互斥只加一个', () => {
  const u = new UsageTracker(path.join(TMP, 'n1.json'), () => {});
  u.recordAttempt('A', 'success', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  u.recordAttempt('A', 'rateLimited');
  u.recordAttempt('B', 'timeout');
  const d = u.getStats().byNode;
  assert.equal(d.A.requests, 2);
  assert.equal(d.A.success, 1);
  assert.equal(d.A.rateLimited, 1);
  assert.equal(d.A.timeout, 0, '分类互斥:一次尝试只能落一个桶');
  assert.equal(d.A.totalTokens, 14);
  assert.equal(d.B.timeout, 1);
  assert.equal(d.B.requests, 1);
});

await t('recordAttempt 认不出的结果类型直接抛(拼错字段会静默丢数)', () => {
  const u = new UsageTracker(path.join(TMP, 'n2.json'), () => {});
  assert.throws(() => u.recordAttempt('A', 'rate_limited'), /未知的节点尝试结果/);
  u.recordAttempt(null, 'success');   // 没节点名时安静跳过,不该崩
  assert.deepEqual(u.getStats().byNode.A ? Object.keys(u.getStats().byNode.A) : [], [],
    '抛之前 requests 已经加过了也没关系,但不能凭空多出一个桶');
});

await t('缓存 token 三种写法都认得(上游把底层模型的 usage 原样带出来)', () => {
  const u = new UsageTracker(path.join(TMP, 'n3.json'), () => {});
  u.recordAttempt('oai', 'success', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } });
  u.recordAttempt('ant', 'success', { prompt_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 25 });
  u.recordAttempt('none', 'success', { prompt_tokens: 100, completion_tokens: 5 });
  const d = u.getStats().byNode;
  assert.equal(d.oai.cacheReadTokens, 60);
  assert.equal(d.ant.cacheReadTokens, 40);
  assert.equal(d.ant.cacheWriteTokens, 25);
  assert.equal(d.none.cacheReadTokens, 0, '上游没给就是 0 —— 命中率那边靠分母判「无数据」');
});

await t('旧 usage.json 没有 byNode 也能加载,不做破坏性迁移', () => {
  const f = path.join(TMP, 'old.json');
  fs.writeFileSync(f, JSON.stringify({
    total: { requests: 7, success: 6, fail: 1, promptTokens: 70, completionTokens: 30, reasoningTokens: 0, totalTokens: 100 },
    byDay: { '2026-01-01': { requests: 7 } },
    byModel: { 'deepseek-v4-flash-free': { requests: 7 } },
    lastRequest: 1735689600000, startTime: 1735689000000,
  }));
  const u = new UsageTracker(f, () => {});
  const d = u.getStats();
  assert.equal(d.total.requests, 7, '历史数据必须留着');
  assert.equal(d.byModel['deepseek-v4-flash-free'].requests, 7, '不重写历史模型名');
  assert.equal(d.startTime, 1735689000000);
  assert.deepEqual(d.byNode, {}, '缺的那个补空对象就行,编不出历史的按节点数据');
  u.recordAttempt('A', 'success');
  assert.equal(u.getStats().byNode.A.requests, 1, '补完之后照常能记');
});

await t('旧节点桶缺少新增字段时归一化,后续累加不产生 null', () => {
  const f = path.join(TMP, 'old-node.json');
  fs.writeFileSync(f, JSON.stringify({
    total: { requests: 1, success: 1, fail: 0 }, byDay: {}, byModel: {},
    byNode: { A: { requests: 1, success: 1, promptTokens: 10 } },
    lastRequest: null, startTime: 123,
  }));
  const u = new UsageTracker(f, () => {});
  u.recordAttempt('A', 'success', { prompt_tokens: 5, completion_tokens: 2 }, { ttfb: 200, total: 900 });
  const a = u.getStats().byNode.A;
  assert.equal(a.requests, 2);
  assert.equal(a.completionTokens, 2);
  assert.equal(a.cacheReadTokens, 0);
  assert.equal(a.hasCacheData, false);
  assert.equal(a.ttfbMs, 200, '旧桶没有耗时字段,补 0 再累加,不能变成 null');
  assert.equal(a.ttfbCount, 1);
  assert.equal(a.durationMs, 900);
  assert.equal(a.durationCount, 1, '样本数只数有耗时数据的那些 —— 旧桶那 1 次不算');
});

await t('耗时只在传了 timing 时累计,ttfb 测不到不记样本', () => {
  const u = new UsageTracker(path.join(TMP, 'timing.json'), () => {});
  u.recordAttempt('A', 'success', null, { ttfb: 300, total: 1200 });
  u.recordAttempt('A', 'success', null, { ttfb: 0, total: 800 });   // 流开了却没收到 chunk
  u.recordAttempt('A', 'rateLimited');                              // 被秒拒,不带 timing
  const a = u.getStats().byNode.A;
  assert.equal(a.ttfbMs, 300);
  assert.equal(a.ttfbCount, 1, 'ttfb 记 0 会把平均值稀释成谁都没经历过的数');
  assert.equal(a.durationMs, 2000);
  assert.equal(a.durationCount, 2);
  assert.equal(a.requests, 3, '不带 timing 的尝试照常计数');
});

await t('recordAttempt 记下这次尝试的时间(面板靠它把最近调用排在最上面)', () => {
  const u = new UsageTracker(path.join(TMP, 'lastat.json'), () => {});
  const before = Date.now();
  u.recordAttempt('A', 'success', null, { ttfb: 100, total: 200 });
  const a = u.getStats().byNode.A;
  assert.ok(a.lastAt >= before && a.lastAt <= Date.now(), `lastAt 应落在这次调用区间内,实际 ${a.lastAt}`);

  // 失败的尝试也算「打过」:一直被限流的节点正是最该看见的那个
  u.recordAttempt('B', 'rateLimited');
  assert.ok(u.getStats().byNode.B.lastAt > 0, '不带 timing 的尝试也要记时间');
});

await t('recordAttempt 记下这次尝试发出的模型和思考强度(面板靠它核对 max 有没有真发出去)', () => {
  const u = new UsageTracker(path.join(TMP, 'lastcall.json'), () => {});
  u.recordAttempt('A', 'success', null, { ttfb: 100, total: 200 },
    { model: 'deepseek-v4-flash-free', effort: 'max' });
  const a = u.getStats().byNode.A;
  assert.equal(a.lastModel, 'deepseek-v4-flash-free');
  assert.equal(a.lastEffort, 'max');

  // 没发 reasoning_effort(随上游默认)和显式发了 high 是两回事,得能区分出来
  u.recordAttempt('A', 'success', null, null, { model: 'big-pickle', effort: '' });
  assert.equal(u.getStats().byNode.A.lastEffort, '', '空强度表示没发这个字段');
  assert.equal(u.getStats().byNode.A.lastModel, 'big-pickle', '每次尝试都覆盖成最近一次');

  // 429 这种没 usage/timing 的尝试同样要留下模型和强度,否则限流行看不出在跑什么
  u.recordAttempt('B', 'rateLimited', null, null, { model: 'm', effort: 'high' });
  assert.equal(u.getStats().byNode.B.lastEffort, 'high');

  // 不传 call 时不能把已有的值抹掉
  u.recordAttempt('B', 'timeout');
  assert.equal(u.getStats().byNode.B.lastModel, 'm', '不传 call 应保留上次的值');
});

await t('缓存字段明确返回 0 与完全缺失能区分', () => {
  const u = new UsageTracker(path.join(TMP, 'cache-presence.json'), () => {});
  u.recordAttempt('missing', 'success', { prompt_tokens: 10 });
  u.recordAttempt('zero', 'success', {
    prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 },
  });
  assert.equal(u.getStats().byNode.missing.hasCacheData, false);
  assert.equal(u.getStats().byNode.zero.hasCacheData, true);
});

await t('清零把 byNode 一起清(只清一半会让两套口径对不上)', () => {
  const f = path.join(TMP, 'n4.json');
  const u = new UsageTracker(f, () => {});
  u.recordAttempt('A', 'success', { prompt_tokens: 1, total_tokens: 1 });
  u.record('m', { prompt_tokens: 1, total_tokens: 1 }, true);
  u.reset();
  assert.deepEqual(u.getStats().byNode, {});
  assert.deepEqual(new UsageTracker(f, () => {}).getStats().byNode, {}, '清零得落盘');
});

// ── 调用日志(calls)──────────────────────────────────────

await t('每条成功调用单独记一行,同一节点的不同强度都留得住', () => {
  // 这条是这套记录存在的理由:byNode 的 lastEffort 会被后一次覆盖成 '',
  // 而排查「客户端设了 max 却变成 high」要看的正是被覆盖掉的那几次
  const u = new UsageTracker(path.join(TMP, 'calls1.json'), () => {});
  const mk = (effort) => u.recordAttempt('A', 'success',
    { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } },
    { ttfb: 100, total: 900 }, { model: 'ds4f', effort });
  mk('high'); mk('max'); mk('');

  const c = u.getStats().calls;
  assert.equal(c.length, 3, '三次调用三行,不是覆盖成一行');
  assert.deepEqual(c.map((x) => x.effort), ['high', 'max', ''], '按发生顺序追加');
  assert.equal(u.getStats().byNode.A.lastEffort, '', '对照:聚合桶里只剩最后一次');
  assert.equal(c[0].node, 'A');
  assert.equal(c[0].model, 'ds4f');
  assert.equal(c[0].in, 10);
  assert.equal(c[0].out, 4);
  assert.equal(c[0].reasoning, 2);
  assert.equal(c[0].ttfb, 100);
  assert.equal(c[0].ms, 900);
  assert.ok(c[0].at > 0, '得有时间戳,面板靠它排序和显示时刻');
});

await t('只有成功的调用进日志(失败的没 token 没耗时,会把跑通的挤出窗口)', () => {
  const u = new UsageTracker(path.join(TMP, 'calls2.json'), () => {});
  u.recordAttempt('A', 'rateLimited', null, null, { model: 'm', effort: 'max' });
  u.recordAttempt('A', 'timeout');
  u.recordAttempt('A', 'upstreamError');
  assert.deepEqual(u.getStats().calls, [], '失败的三类都不进');
  // 但它们在 byNode 的计数里得留着 —— 面板的「累计限流/超时/错误」读的就是那儿
  assert.equal(u.getStats().byNode.A.rateLimited, 1);
  assert.equal(u.getStats().byNode.A.timeout, 1);
  assert.equal(u.getStats().byNode.A.upstreamError, 1);
});

await t('没有 usage / timing 的成功调用也记一行,缺的字段归零而不是 undefined', () => {
  const u = new UsageTracker(path.join(TMP, 'calls3.json'), () => {});
  u.recordAttempt('A', 'success');                              // 上游没报 usage
  u.recordAttempt('B', 'success', null, { ttfb: 0, total: 500 });  // 流开了没收到 chunk
  const [a, b] = u.getStats().calls;
  assert.equal(a.in, 0);
  assert.equal(a.out, 0);
  assert.equal(a.reasoning, 0);
  assert.equal(a.ttfb, null, '没 timing 就是 null,不能是 undefined —— JSON 会把它整个键丢掉');
  assert.equal(a.ms, null);
  assert.equal(a.model, '', '不传 call 时归一成空串,前端靠它兜底显示 —');
  assert.equal(a.effort, '');
  // ttfb 记 0 会把平均值稀释成谁都没经历过的数,和 byNode 那边同一个判断
  assert.equal(b.ttfb, null, '测不到首字节存 null');
  assert.equal(b.ms, 500, '总耗时是真实的 500,照记');
});

await t('调用日志到上限就丢最旧的,不会把文件撑爆', () => {
  const u = new UsageTracker(path.join(TMP, 'calls4.json'), () => {});
  for (let i = 0; i < CALL_LOG_LIMIT + 30; i++) {
    u.recordAttempt('A', 'success', null, null, { model: `m${i}`, effort: 'max' });
  }
  const c = u.getStats().calls;
  assert.equal(c.length, CALL_LOG_LIMIT, '窗口固定,不随时间无限涨');
  assert.equal(c[0].model, 'm30', '丢的是最旧的那 30 条');
  assert.equal(c.at(-1).model, `m${CALL_LOG_LIMIT + 29}`, '最新的一定在');
});

await t('清零把 calls 一起清(留着的话时间线里会横着一段清零前的旧记录)', () => {
  const f = path.join(TMP, 'calls5.json');
  const u = new UsageTracker(f, () => {});
  u.recordAttempt('A', 'success', { prompt_tokens: 1 }, null, { model: 'm', effort: 'max' });
  u.record('m', { prompt_tokens: 1, total_tokens: 1 }, true);   // 顺手落盘
  u.reset();
  assert.deepEqual(u.getStats().calls, []);
  assert.deepEqual(new UsageTracker(f, () => {}).getStats().calls, [], '清零得落盘');
});

await t('旧 usage.json 没有 calls 时补空数组,不编造历史条目', () => {
  const f = path.join(TMP, 'old-calls.json');
  fs.writeFileSync(f, JSON.stringify({
    total: { requests: 3, success: 3, fail: 0 }, byDay: {}, byModel: {},
    // 聚合桶里的 lastModel/lastEffort 只够还原最近一次,拆不出这 3 次分别是什么
    byNode: { A: { requests: 3, success: 3, lastModel: 'ds4f', lastEffort: 'max' } },
    lastRequest: null, startTime: 123,
  }));
  const u = new UsageTracker(f, () => {});
  assert.deepEqual(u.getStats().calls, []);
  u.recordAttempt('A', 'success', null, null, { model: 'ds4f', effort: 'high' });
  assert.equal(u.getStats().calls.length, 1, '补完之后照常能记');
});

await t('文件里存了超量 calls 时加载就裁到上限(换小上限后不该一直超着)', () => {
  const f = path.join(TMP, 'fat-calls.json');
  const fat = Array.from({ length: CALL_LOG_LIMIT + 50 }, (_, i) => ({ at: i, node: 'A', model: `m${i}` }));
  fs.writeFileSync(f, JSON.stringify({
    total: { requests: 0, success: 0, fail: 0 }, byDay: {}, byModel: {}, byNode: {},
    calls: fat, lastRequest: null, startTime: 123,
  }));
  const c = new UsageTracker(f, () => {}).getStats().calls;
  assert.equal(c.length, CALL_LOG_LIMIT);
  assert.equal(c.at(-1).model, `m${CALL_LOG_LIMIT + 49}`, '裁的是旧的那头');
});

await t('calls 坏成对象/字符串时退回空数组,不让面板拿着它去 map', () => {
  for (const bad of [{}, 'nope', 42]) {
    const f = path.join(TMP, `bad-calls-${typeof bad}.json`);
    fs.writeFileSync(f, JSON.stringify({
      total: { requests: 0, success: 0, fail: 0 }, byDay: {}, byModel: {}, byNode: {},
      calls: bad, lastRequest: null, startTime: 1,
    }));
    assert.deepEqual(new UsageTracker(f, () => {}).getStats().calls, []);
  }
});

// ── OpenCode 身份头 ─────────────────────────────────────

await t('身份头:缺的补默认值,客户端给了的优先', () => {
  const h = identityHeaders({ headers: { 'x-opencode-project': 'my-proj' } }, () => 'uuid-1');
  assert.equal(h['User-Agent'], 'opencode-cli/1.0.0');
  assert.equal(h['x-opencode-client'], 'cli');
  assert.equal(h['x-opencode-project'], 'my-proj', '客户端值优先');
  assert.equal(h['x-opencode-request'], 'uuid-1');
  assert.equal(h['x-opencode-session'], 'uuid-1');
  assert.equal(h['x-title'], undefined, '没合理默认值的就别凭空造');
});

await t('身份头:读入站头大小写不敏感', () => {
  // Node 收到的 req.headers 本来就是小写,但客户端和测试夹具不一定 ——
  // 大小写敏感的话「客户端值优先」这条会在真实请求上悄悄失效
  const h = identityHeaders({ headers: { 'USER-AGENT': 'my-cli/9', 'X-Opencode-Session': ' sess-7 ' } }, () => 'uuid-2');
  assert.equal(h['User-Agent'], 'my-cli/9');
  assert.equal(h['x-opencode-session'], 'sess-7', '顺手去掉首尾空白');
});

await t('身份头:session 依次找三个来源', () => {
  const a = identityHeaders({ headers: { 'x-session-affinity': 'aff-1' } }, () => 'u');
  assert.equal(a['x-opencode-session'], 'aff-1');
  const b = identityHeaders({ headers: { 'x-session-id': 'sid-1' } }, () => 'u');
  assert.equal(b['x-opencode-session'], 'sid-1');
  assert.equal(b['x-session-id'], 'sid-1', 'x-session-id 本身也照原样透传');
});

await t('身份头:不同请求的 request ID 不一样', () => {
  const a = identityHeaders({ headers: {} });
  const b = identityHeaders({ headers: {} });
  assert.notEqual(a['x-opencode-request'], b['x-opencode-request']);
  assert.match(a['x-opencode-request'], /^[0-9a-f-]{36}$/);
});

await t('reqOpts:开关关着时出站还是裸 User-Agent: node', () => {
  const g = new Gateway(load(), () => {});
  const off = g.reqOpts('{}', { accept: '*/*', timeout: 1000 });
  assert.equal(off.headers['User-Agent'], 'node');
  assert.equal(off.headers['x-opencode-client'], undefined);
  assert.equal(off.headers.Authorization, undefined, '免费端点认的就是「不带 Bearer」这个形态');

  const on = g.reqOpts('{}', { accept: '*/*', timeout: 1000, identity: identityHeaders({ headers: {} }) });
  assert.equal(on.headers['User-Agent'], 'opencode-cli/1.0.0', '身份头得盖掉默认的 node');
  assert.equal(on.headers['x-opencode-client'], 'cli');
  assert.equal(on.headers['Content-Length'], 2, 'Content-Length 排在身份头后面,不能被盖掉');
});

// ── 两套账在重试循环里怎么分叉 ──────────────────────────

/** attempt() 对 res 只用 writeHead/end/write,不用真起 HTTP 服务就能验状态机 */
function fakeRes() {
  const r = { code: 0, chunks: [] };
  r.writeHead = (c) => { r.code = c; return r; };
  r.write = (c) => { r.chunks.push(String(c)); return true; };
  r.end = (c) => { if (c) r.chunks.push(String(c)); r.ended = true; };
  Object.defineProperty(r, 'body', { get: () => r.chunks.join('') });
  return r;
}

/**
 * 只跑重试循环的 Gateway:出站换成脚本,switchNode 记下换到哪儿并立刻成功
 * (真的那个要 sleep(1000) 等连接建起来,这里等不起)。
 * 脚本按「第几次出站」返回:抛 {status} 就是那个错,返回对象就是成功。
 */
function retryGateway(file, script) {
  const g = new Gateway(load(), () => {});
  g.usage = new UsageTracker(path.join(TMP, file), () => {});
  g.getCurrentNode = async () => g.cur;
  g.switchNode = async (name) => { g.cur = name; return true; };
  g.saveLastNode = () => {};
  g.tries = [];
  const run = async () => {
    const i = g.tries.length;
    g.tries.push(g.cur);          // 记「这一次出站用的是哪个节点」
    return script(i, g.cur);
  };
  g.forward = run;
  g.forwardStream = run;
  return g;
}

const BODY = { model: FREE_MODELS[0], messages: [{ role: 'user', content: 'hi' }] };

await t('A 撞 429、B 成功:总览记 1 次成功,两个节点各记自己那一笔', async () => {
  const g = retryGateway('sm1.json', (i) => {
    if (i === 0) throw Object.assign(new Error('429'), { status: 429 });
    return { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
  });
  g.cur = 'A';
  const res = fakeRes();
  await g.attempt(res, BODY, ['A', 'B'], 'A', false, OPENAI, Date.now() + 60_000);

  assert.equal(res.code, 200, '客户端最终拿到的是成功');
  const d = g.usage.getStats();
  assert.equal(d.total.requests, 1, '客户端口径:换了节点也只算一次请求');
  assert.equal(d.total.success, 1);
  assert.equal(d.total.fail, 0, '中途那次 429 不算客户端失败 —— 它最后成功了');
  assert.equal(d.total.totalTokens, 7);
  assert.equal(d.byNode.A.requests, 1);
  assert.equal(d.byNode.A.rateLimited, 1);
  assert.equal(d.byNode.A.success, 0);
  assert.equal(d.byNode.A.totalTokens, 0, '被限流的那次没有 token');
  assert.equal(d.byNode.B.requests, 1);
  assert.equal(d.byNode.B.success, 1);
  assert.equal(d.byNode.B.totalTokens, 7, 'token 记在真正干活的那个节点上');
  assert.deepEqual(g.tries, ['A', 'B']);
});

await t('同一节点上的网络重试:每次真发出去都记一笔,不是整段算一次', async () => {
  // 网络错误只重试当前节点(换了也白换),重试满了才换 —— 于是 A 上会有
  // 3 笔 timeout(首发 + 2 次重试),这正是「按真实上游尝试计」要体现的
  const g = retryGateway('sm2.json', (i) => {
    if (i < 3) throw Object.assign(new Error('socket hang up'), { status: 0 });
    return { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } };
  });
  g.cur = 'A';
  const res = fakeRes();
  await g.attempt(res, BODY, ['A', 'B'], 'A', false, OPENAI, Date.now() + 60_000);

  const d = g.usage.getStats();
  assert.equal(d.total.requests, 1);
  assert.equal(d.total.success, 1);
  assert.equal(d.byNode.A.requests, 3, '首发一次 + 重试两次');
  assert.equal(d.byNode.A.timeout, 3);
  assert.equal(d.byNode.B.success, 1);
  assert.deepEqual(g.tries, ['A', 'A', 'A', 'B']);
});

await t('全员 429:客户端记 1 次失败,每个节点各记自己被限流那次', async () => {
  const g = retryGateway('sm3.json', () => {
    throw Object.assign(new Error('429'), { status: 429 });
  });
  g.cur = 'A';
  const res = fakeRes();
  await g.attempt(res, BODY, ['A', 'B'], 'A', false, OPENAI, Date.now() + 60_000);

  assert.equal(res.code, 429);
  const d = g.usage.getStats();
  assert.equal(d.total.requests, 1);
  assert.equal(d.total.fail, 1);
  assert.equal(d.byNode.A.rateLimited, 1);
  assert.equal(d.byNode.B.rateLimited, 1);
  assert.equal(Object.keys(d.byNode).length, 2, '没试过的节点不该凭空出现在统计里');
});

await t('流式首字节之后中断:节点记上游错误、总览记失败,而且不换节点', async () => {
  // 头都发出去了,换节点等于给客户端拼两半响应 —— 所以这里必须只有一次尝试
  const g = retryGateway('sm4.json', () => {
    throw Object.assign(new Error('read ECONNRESET'), { status: 0, notStarted: false });
  });
  g.cur = 'A';
  const res = fakeRes();
  await g.attempt(res, BODY, ['A', 'B'], 'A', true, ANTHROPIC, Date.now() + 60_000);

  const d = g.usage.getStats();
  assert.equal(d.byNode.A.upstreamError, 1);
  assert.equal(d.byNode.A.timeout, 0, '首字节之后断了算上游错误,不算超时');
  assert.equal(d.byNode.B, undefined, '不能换节点重试');
  assert.equal(d.total.requests, 1);
  assert.equal(d.total.fail, 1);
  assert.deepEqual(g.tries, ['A']);
  assert.ok(res.ended, '得把响应关掉,不然客户端挂到超时');
});

await t('流式成功:usage 记在节点上,总览也拿到同一份', async () => {
  const g = retryGateway('sm5.json', () => ({ ok: true, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }));
  g.cur = 'A';
  await g.attempt(fakeRes(), BODY, ['A'], 'A', true, ANTHROPIC, Date.now() + 60_000);

  const d = g.usage.getStats();
  assert.equal(d.byNode.A.success, 1);
  assert.equal(d.byNode.A.totalTokens, 12);
  assert.equal(d.total.success, 1);
  assert.equal(d.total.totalTokens, 12);
  assert.equal(d.byModel[FREE_MODELS[0]].requests, 1, '按客户端真选的模型记,不是写死那个');
});

await t('流式中断的节点不锁定,下次请求不能继续优先粘着它', async () => {
  const g = retryGateway('sm6.json', () => ({ ok: false, usage: null }));
  g.cur = 'A';
  await g.attempt(fakeRes(), BODY, ['A'], 'A', true, ANTHROPIC, Date.now() + 60_000);

  assert.equal(g.lockedNode, null);
  assert.equal(g.usage.getStats().byNode.A.upstreamError, 1);
});

await t('换节点失败时继续找下一个,不能回头再打刚限流的节点', async () => {
  const g = retryGateway('sm7.json', (i, node) => {
    if (i === 0) throw Object.assign(new Error('429'), { status: 429 });
    assert.equal(node, 'C', 'B 切换失败后应继续尝试 C,不能仍从 A 出站');
    return { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } };
  });
  g.cur = 'A';
  const switched = [];
  g.switchNode = async (name) => {
    switched.push(name);
    if (name === 'B') return false;
    g.cur = name;
    return true;
  };

  await g.attempt(fakeRes(), BODY, ['A', 'B', 'C'], 'A', false, OPENAI, Date.now() + 60_000);

  assert.deepEqual(switched, ['B', 'C']);
  assert.deepEqual(g.tries, ['A', 'C']);
  assert.equal(g.usage.getStats().byNode.C.success, 1);
});

await t('全员超时报的是超时,不能报「节点全挂」', async () => {
  // 回归:大上下文 prefill 慢会把每次尝试都拖成超时,而原来的出口不看原因,
  // 一律回 503 all_nodes_unavailable —— 照那句话去查节点是白费功夫。
  const g = retryGateway('sm8.json', () => {
    throw Object.assign(new Error('socket hang up'), { status: 0 });
  });
  g.cur = 'A';
  const res = fakeRes();
  await g.attempt(res, BODY, ['A'], 'A', false, OPENAI, Date.now() + 60_000);

  assert.equal(res.code, 504);
  assert.match(res.body, /timed out/);
  assert.ok(!res.body.includes('all_nodes_unavailable'), '超时不是「节点不可用」');
  assert.equal(g.usage.getStats().byNode.A.timeout, 3, '首发 + 2 次重试');
});

await t('预算已经没了就直接回超时,一个节点都不试', async () => {
  const g = retryGateway('sm9.json', () => { throw new Error('不该出站'); });
  g.cur = 'A';
  const res = fakeRes();
  await g.attempt(res, BODY, ['A', 'B'], 'A', false, OPENAI, Date.now() + 1_000);

  assert.equal(res.code, 504);
  assert.deepEqual(g.tries, [], '剩不到一次尝试的时间了,发出去只是白等');
  assert.equal(g.usage.getStats().total.fail, 1);
  assert.equal(g.usage.getStats().byNode.A, undefined, '没发出去就不算节点的一次尝试');
});

await t('时间预算按请求体积放大,大到 1Mi 也装得下', () => {
  assert.ok(budgetFor(2_000) - REQUEST_DEADLINE_MS < 1_000, '几 KB 的小请求最多加出不到一秒,行为和以前一样');
  assert.ok(budgetFor(4.3 * 1048576) > 350_000, '1M 上下文实测最坏 129s prefill,预算得装得下');
  assert.ok(silentFor(4.3 * 1048576) > 220_000);
  assert.equal(budgetFor(999 * 1048576), 420_000, '再大也得有个顶,不能挂到天荒地老');
  assert.equal(silentFor(999 * 1048576), 240_000);
  // 连续放大,不分档 —— 分档会让刚卡在档位下面的请求白等
  assert.ok(budgetFor(0.9 * 1048576) > budgetFor(0.8 * 1048576));
  assert.ok(silentFor(0.9 * 1048576) > silentFor(0.8 * 1048576));
});

// ── 节点延迟与排序 ──────────────────────────────────────

/** 造一个不需要内核的 Gateway:mihomoApi 换成假的。
 *  照真内核的行为回 —— 组延迟只回测通的那些,一个都没通就 500。 */
function fakeGateway(delays) {
  const g = new Gateway(load(), () => {});
  const names = Object.keys(delays);
  g.mihomoApi = async (p) => {
    if (!p.startsWith('/group/')) return { all: names, now: names[0] };
    const mp = Object.fromEntries(Object.entries(delays).filter(([, d]) => d != null));
    if (!Object.keys(mp).length) throw new Error('HTTP 500: all proxies timeout');
    return mp;
  };
  return g;
}

await t('测延迟:不通的记 null,通的记毫秒', async () => {
  const g = fakeGateway({ A: 300, B: null, C: 80 });
  const r = await g.testNodes();
  assert.equal(r.tested, 3);
  assert.equal(r.alive, 2);
  assert.deepEqual(r.dead, ['B']);
  assert.deepEqual(r.fastest, { node: 'C', delay: 80 });
  assert.deepEqual(g.delayMap(), { A: 300, B: null, C: 80 });
  assert.ok(g.testedAt > 0);
});

await t('节点名里带斜杠也能测(机场爱写「1.4MB/s」)', async () => {
  // 逐个打 /proxies/{名字}/delay 时这种名字要靠内核反转义 %2F 才对得上;
  // 走组接口名字只出现在响应体里,这条锁住的就是这个选择
  const g = fakeGateway({ '🇫🇮FI_1|1.4MB/s': 240, '🇯🇵JP_1|6.1MB/s': null });
  const r = await g.testNodes();
  assert.equal(r.alive, 1);
  assert.deepEqual(r.fastest, { node: '🇫🇮FI_1|1.4MB/s', delay: 240 });
  assert.deepEqual(r.dead, ['🇯🇵JP_1|6.1MB/s']);
});

await t('探针参数:打 https,timeout 在内核解析得了的范围里', async () => {
  const g = fakeGateway({ A: 100 });
  let seen = '';
  const inner = g.mihomoApi;
  g.mihomoApi = (p, ...a) => { if (p.startsWith('/group/')) seen = p; return inner(p, ...a); };
  await g.testNodes();
  const q = new URLSearchParams(seen.split('?')[1]);
  assert.match(q.get('url'), /^https:\/\//, '得走 443 —— 机场封 80 端口很常见,那会把好节点全判死');
  const to = Number(q.get('timeout'));
  assert.ok(to > 0 && to <= 32767, '内核那边 timeout 按 int16 解析,超了整个请求直接 400');
});

await t('rankNodes 按延迟排序并剔除不通的', async () => {
  const g = fakeGateway({ A: 300, B: null, C: 80 });
  await g.testNodes();
  assert.deepEqual(g.rankNodes(['A', 'B', 'C']), ['C', 'A'], '快的在前,B 直接不在表里');
  assert.deepEqual(g.excludedNodes(['A', 'B', 'C']), ['B']);
});

await t('限流过的节点在 rankNodes 里让到队尾,不凭低延迟插回队首', async () => {
  const g = fakeGateway({ A: 300, B: 80, C: 150 });
  await g.testNodes();
  assert.deepEqual(g.rankNodes(['A', 'B', 'C']), ['B', 'C', 'A'], '基线:纯延迟序 B<C<A');
  g.cooldown.mark429('B', 'default');          // 最快的 B 撞了限流
  g.cooldown.cooldowns.delete('B:default');    // 模拟已解冻(冷却过期清掉,lastMarked 还在)
  assert.deepEqual(g.rankNodes(['A', 'B', 'C']), ['C', 'A', 'B'],
    'B 刚限流过,即便解冻也排到没限流的 C/A 后面,不靠低延迟插队');
});

await t('没测过时 rankNodes 原样返回(退化成订阅顺序,不是空表)', () => {
  const g = new Gateway(load(), () => {});
  assert.deepEqual(g.rankNodes(['A', 'B']), ['A', 'B']);
  assert.deepEqual(g.excludedNodes(['A', 'B']), [], '没数据就别声称谁不可用');
});

await t('全灭时不剔除 —— 探针地址不可达不等于节点不可用', async () => {
  const g = fakeGateway({ A: null, B: null });
  const r = await g.testNodes();
  assert.equal(r.alive, 0);
  assert.deepEqual(g.rankNodes(['A', 'B']), ['A', 'B'], '全剔掉等于把整个网关关掉');
  assert.deepEqual(g.excludedNodes(['A', 'B']), []);
});

await t('全灭时 rankNodes 不打日志(面板每 2 秒轮一次,会刷满屏)', async () => {
  const lines = [];
  const g = new Gateway(load(), (lv, m) => lines.push(m));
  g.mihomoApi = async (p) => {
    if (!p.startsWith('/group/')) return { all: ['A', 'B'], now: 'A' };
    throw new Error('HTTP 500: all proxies timeout');
  };
  await g.testNodes();
  const n = lines.length;
  for (let i = 0; i < 5; i++) { g.rankNodes(['A', 'B']); g.excludedNodes(['A', 'B']); }
  assert.equal(lines.length, n, '原因由测延迟那次说清楚,排序本身不该出声');
  assert.ok(lines.some((m) => m.includes('all proxies timeout')), '内核给的原因必须落到日志里');
});

await t('测过之后才出现的节点保留在表尾,不当成死的', async () => {
  const g = fakeGateway({ A: 300, B: 80 });
  await g.testNodes();
  assert.deepEqual(g.rankNodes(['A', 'B', 'NEW']), ['B', 'A', 'NEW']);
  assert.deepEqual(g.excludedNodes(['A', 'B', 'NEW']), [], '没测过的不算不可用');
});

await t('锁定的节点测不通时解锁', async () => {
  const g = fakeGateway({ A: 300, B: null });
  g.lockedNode = 'B';
  await g.testNodes();
  assert.equal(g.lockedNode, null, '不然 ensureNode 会一直粘着一个已知不通的节点');
});

await t('并发测延迟只跑一遍', async () => {
  let calls = 0;
  const g = fakeGateway({ A: 100, B: 200 });
  const inner = g.mihomoApi;
  g.mihomoApi = (...a) => { calls++; return inner(...a); };
  const [r1, r2] = await Promise.all([g.testNodes(), g.testNodes()]);
  assert.equal(r1, r2, '第二个调用应搭车,不是再测一轮');
  assert.equal(calls, 2, '1 次取节点 + 1 次整组测延迟');
  assert.equal(g.testing, null, '测完要把占位清掉,否则下次点测延迟直接返回旧结果');
});

await t('一个节点都没有时测延迟不抛', async () => {
  const g = new Gateway(load(), () => {});
  g.mihomoApi = async () => ({ all: [] });
  const r = await g.testNodes();
  assert.equal(r.tested, 0);
  assert.equal(r.fastest, null);
});

// ── 免费模型清单 ────────────────────────────────────────

await t('pickFreeModels 只认 -free 后缀和 big-pickle,顺带去重', () => {
  assert.deepEqual(
    pickFreeModels(['claude-sonnet-4', 'mimo-v2.5-free', 'big-pickle', 'gpt-5', 'mimo-v2.5-free']),
    ['mimo-v2.5-free', 'big-pickle'],
    '付费模型不能列出来 —— 网关不带 Authorization 出站,它们必然 401');
  assert.deepEqual(pickFreeModels([null, '', '   ', undefined, 42]), [], '坏值全丢掉,不抛');
  assert.deepEqual(pickFreeModels(), []);
  assert.deepEqual(pickFreeModels(['  x-free  ']), ['x-free'], '两头空白得修掉,不然面板上那个胶囊里带空格');
});

await t('拉到清单就换成上游那份,新增了什么记一行日志', async () => {
  const lines = [];
  const g = new Gateway(load(), (lv, m) => lines.push(m));
  g.upstreamGet = async () => ({ data: [{ id: 'a-free' }, { id: 'big-pickle' }, { id: 'claude-x' }] });
  assert.deepEqual(g.freeModels(), FREE_MODELS, '第一次调用不等出站,先给兜底那份');
  const r = await g.refreshModels();
  assert.deepEqual(r.models, ['a-free', 'big-pickle']);
  // added/gone 是给「同步模型」那颗按钮的 toast 用的:清单几周才变一次,
  // 只说「同步完成」看不出到底拉到了没有
  assert.ok(r.added.includes('a-free'), '兜底里没有 a-free,它算新增');
  assert.ok(r.gone.includes('deepseek-v4-flash-free'), '兜底里有、上游没给的算下线');
  assert.deepEqual(g.freeModels(), ['a-free', 'big-pickle']);
  assert.ok(lines.some((m) => m.includes('a-free')), '上游新上线一个免费模型,日志里得看得见');
});

await t('拉失败或拉到空时继续用上一份,面板那一列不会变空', async () => {
  const stubs = [
    async () => { throw new Error('ECONNREFUSED'); },
    async () => ({ data: [{ id: 'claude-x' }] }),   // 形状对但一个免费的都没有 -> 当失败
  ];
  for (const stub of stubs) {
    const g = new Gateway(load(), () => {});
    g.upstreamGet = stub;
    // 失败要往外抛:手动那条路(POST /api/models/sync)得把原因报给用户,
    // 自动那两条(开机 / freeModels 的后台刷新)自己 catch 掉
    await assert.rejects(g.refreshModels());
    assert.deepEqual(g.freeModels(), FREE_MODELS, '前端已经没有本地常量兜底了,这里空了面板就空');
  }
});

await t('拉清单先直连,直连不通才回落到代理', async () => {
  const seen = [];
  const g = new Gateway(load(), () => {});
  // 第三个参数是 agent:传 null 才是直连,默认那次带的是 MihomoAgent
  g.upstreamGet = async (path, timeout, agent = 'PROXY') => {
    seen.push(agent);
    if (agent === null) throw new Error('ECONNREFUSED');   // 直连被墙
    return { data: [{ id: 'a-free' }] };
  };
  assert.deepEqual((await g.refreshModels()).models, ['a-free']);
  assert.deepEqual(seen, [null, 'PROXY'], '顺序不能反 —— 直连省一次经节点的出站,且内核没起来时它是唯一的路');

  // 直连能通就不该再走代理:免费额度按出口 IP 算,白占一次节点出站没意义
  const only = [];
  const g2 = new Gateway(load(), () => {});
  g2.upstreamGet = async (path, timeout, agent = 'PROXY') => {
    only.push(agent);
    return { data: [{ id: 'b-free' }] };
  };
  assert.deepEqual((await g2.refreshModels()).models, ['b-free']);
  assert.deepEqual(only, [null], '直连成功就到此为止');
});

await t('直连和代理都不通时继续用上一份', async () => {
  const g = new Gateway(load(), () => {});
  let calls = 0;
  g.upstreamGet = async () => { calls++; throw new Error('down'); };
  await assert.rejects(g.refreshModels());
  assert.equal(calls, 2, '两条路都试过了');
  assert.deepEqual(g.freeModels(), FREE_MODELS);
});

await t('拉失败也推进 modelsAt,否则面板每 2 秒轮询就每 2 秒重试一次出站', async () => {
  let calls = 0;
  const g = new Gateway(load(), () => {});
  g.upstreamGet = async () => { calls++; throw new Error('down'); };
  await assert.rejects(g.refreshModels());
  assert.equal(calls, 2);
  // freeModels 是同步返回缓存 + TTL 内不再刷新。失败时不推进时间戳的话,
  // 这两次调用会各自再开两次出站
  g.freeModels(); g.freeModels();
  assert.equal(calls, 2, 'TTL 没到就不该再试');
});

await t('兜底清单和实测上下文表对得上,不能只补一处', async () => {
  // 两份表都是手写的,漏一处的后果不一样:兜底少了模型 = 拉不到时面板少列;
  // 上下文表少了 = 少个括号。所以只要求前者覆盖后者,反向允许缺 —— 上游新上一个
  // 模型时它会先进兜底清单,上下文得单独实测一次才有数(见 core.js 的注释)
  const { MODEL_CTX } = await import('../web/core.js');
  for (const id of Object.keys(MODEL_CTX)) {
    assert.ok(FREE_MODELS.includes(id), `${id} 有上下文数据却不在兜底清单里`);
  }
  assert.equal(new Set(FREE_MODELS).size, FREE_MODELS.length, '兜底清单不能有重复');
});

await t('TTL 内不重复出站,并发调用共用一次', async () => {
  let calls = 0;
  const g = new Gateway(load(), () => {});
  g.upstreamGet = async () => { calls++; return { data: [{ id: 'a-free' }] }; };
  await Promise.all([g.refreshModels(), g.refreshModels()]);
  assert.equal(calls, 1, '面板 2 秒轮一次,并发挤在一起是常态');
  g.freeModels(); g.freeModels();
  assert.equal(calls, 1, '拿到过就压住,别每次轮询都出一次站');
});

// ── mihomo 配置生成 ────────────────────────────────────

/** 去掉注释行。生成的 yaml 里有成段注释解释取舍,别让它们混进断言。 */
const stripComments = (y) => y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

await t('订阅地址里的 & ? = # 被转义,不会破坏 yaml', () => {
  const y = buildMihomoYaml('https://air.example.com/sub?token=a&b=1#tag');
  assert.ok(y.includes('url: "https://air.example.com/sub?token=a&b=1#tag"'),
    '必须带引号,裸写的话 # 之后会被当注释,token 就被截断了');
});

await t('yaml 含 provider、select 组和两条规则', () => {
  const y = buildMihomoYaml('https://x.example/s');
  assert.match(y, /proxy-providers:/);
  assert.match(y, /name: zen-pool\n\s+type: select/, 'zen-pool 必须是 select,网关要能精确指定节点');
  assert.match(y, /use: \[airport\]/);
  assert.match(y, /DOMAIN-SUFFIX,opencode\.ai,zen-pool/);
  assert.match(y, /MATCH,DIRECT/);
  assert.ok(!/GEOIP|GEOSITE/.test(y), '不能引入 geo 规则,否则镜像得带 geoip.dat');
  assert.match(y, /mixed-port: 17897/);
  assert.match(y, /external-controller: 127\.0\.0\.1:19090/);
  assert.match(y, /proxy-providers:[\s\S]*?airport:[\s\S]*?interval: 0\b/,
    'provider 的周期更新应由网关唯一调度,避免更新后漏测速或双重刷新');
});

await t('不含 DNS fallback,否则内核会去下 MMDB', () => {
  // fallback 会启用 fallback-filter,它默认用 GeoIP 判断 -> 内核启动时联 GitHub
  // 下 Country.mmdb。实测 v1.19.29 如此。容器首启因此多一个必须联外网的步骤。
  // 只看真配置项:注释里解释了为什么不用 fallback,那几行不算
  const y = stripComments(buildMihomoYaml('https://x.example/s'));
  assert.ok(!/fallback/.test(y), 'DNS fallback 会把 MMDB 下载拖进启动路径');
  assert.match(y, /nameserver: \[223\.5\.5\.5, 119\.29\.29\.29\]/);
});

await t('不含 v1.19 已移除的配置项', () => {
  // global-client-fingerprint 在 v1.19.29 被移除,留着会让内核每次启动
  // 往 stderr 吐一行 error —— 而 mihomo.mjs 把 stderr 当 error 喂进面板日志,
  // 用户会看到一条永远消不掉的红字。
  assert.ok(!/global-client-fingerprint/.test(stripComments(buildMihomoYaml('https://x.example/s'))));
});

await t('订阅为空时拒绝生成(宁可不启内核也不写个坏配置)', () => {
  assert.throws(() => buildMihomoYaml(''), /订阅地址为空/);
  assert.throws(() => buildMihomoYaml(undefined), /订阅地址为空/);
});

await t('首次 load 自动生成并落盘 apiKey', () => {
  const cfg = load();
  assert.match(cfg.apiKey, /^zen-[0-9a-f]{8}$/);
  const again = load();
  assert.equal(again.apiKey, cfg.apiKey, '第二次读应拿到同一个 Key,不能每次重启都换');
  assert.notEqual(genApiKey(), genApiKey());
});

await t('自动更新小时数默认一小时、合法值持久化、旧配置兼容', async () => {
  const f = path.join(TMP, 'config.json');
  const saved = fs.readFileSync(f, 'utf8');
  try {
    const old = JSON.parse(saved);
    delete old.subscriptionUpdateHours;
    fs.writeFileSync(f, JSON.stringify(old));
    assert.equal(load().subscriptionUpdateHours, 1, '旧版原本每小时自动更新,升级后不能静默关闭');

    const c = load();
    c.subscriptionUpdateHours = 6;
    const { save } = await import('../server/config.mjs');
    save(c);
    assert.equal(load().subscriptionUpdateHours, 6, '小时数必须落盘,重启后不能丢');
  } finally {
    fs.writeFileSync(f, saved);
  }
});

await t('自动更新调度:按小时触发,每次更新后自动测速,重排时取消旧计划', async () => {
  const scheduled = [];
  const cleared = [];
  const logs = [];
  const fakeGateway = {
    updateProvider: async () => { logs.push('update'); },
    getAllNodes: async () => { logs.push('nodes'); return ['A', 'B']; },
    testNodes: async () => { logs.push('speed'); return { tested: 2, alive: 2 }; },
  };
  const updater = createSubscriptionUpdater({
    cfg: { subscriptionUrl: 'https://sub.example/a', subscriptionUpdateHours: 2 },
    gateway: fakeGateway,
    logger: (level, msg) => logs.push(`${level}:${msg}`),
    setTimer: (fn, ms) => { const h = { fn, ms }; scheduled.push(h); return h; },
    clearTimer: (h) => cleared.push(h),
  });

  updater.schedule();
  assert.equal(scheduled[0].ms, 2 * 3600_000);
  await scheduled[0].fn();
  assert.deepEqual(logs.filter((x) => ['update', 'nodes', 'speed'].includes(x)), ['update', 'nodes', 'speed'],
    '自动更新的固定顺序应为重拉订阅、读取新节点、自动测速');
  assert.equal(scheduled.length, 2, '执行完要安排下一个周期');

  updater.schedule(4);
  assert.equal(cleared.at(-1), scheduled[1], '修改周期时必须取消旧计划');
  assert.equal(scheduled.at(-1).ms, 4 * 3600_000);

  updater.schedule(8760);
  assert.ok(scheduled.at(-1).ms <= 2_147_000_000,
    'Node 的 setTimeout 超过约 24.8 天会溢出,长周期必须分段等待');
  updater.stop();
  assert.equal(cleared.at(-1), scheduled.at(-1));
});

await t('自动更新关闭、无订阅、更新失败时行为可控', async () => {
  let scheduled = 0, speed = 0;
  const cfg = { subscriptionUrl: '', subscriptionUpdateHours: 3 };
  const updater = createSubscriptionUpdater({
    cfg,
    gateway: { updateProvider: async () => { throw new Error('down'); }, getAllNodes: async () => ['A'], testNodes: async () => { speed++; } },
    logger: () => {},
    setTimer: () => { scheduled++; return {}; },
    clearTimer: () => {},
  });
  updater.schedule();
  assert.equal(scheduled, 0, '没有订阅地址时不应启动空转定时器');
  cfg.subscriptionUrl = 'https://sub.example/a';
  updater.schedule(0);
  assert.equal(scheduled, 0, '0 小时表示关闭');
  await updater.run();
  assert.equal(speed, 0, '更新失败后不能拿旧节点表冒充新订阅测速');
});

await t('自动更新成功后即使节点为空也会自动测速', async () => {
  let speed = 0;
  const updater = createSubscriptionUpdater({
    cfg: { subscriptionUrl: 'https://sub.example/a', subscriptionUpdateHours: 1 },
    gateway: {
      updateProvider: async () => {}, getAllNodes: async () => [],
      testNodes: async () => { speed++; return { tested: 0, alive: 0 }; },
    },
    logger: () => {},
  });
  await updater.run();
  assert.equal(speed, 1, '每次更新都必须紧接自动测速,空节点也不能跳过');
});

// ── 鉴权 ────────────────────────────────────────────────

await t('parseBasic 解出用户名密码,密码里有冒号也不截断', () => {
  const h = 'Basic ' + Buffer.from('admin:p:a:ss').toString('base64');
  assert.deepEqual(parseBasic(h), { user: 'admin', pass: 'p:a:ss' });
  assert.equal(parseBasic('Bearer xxx'), null);
  assert.equal(parseBasic(''), null);
  assert.equal(parseBasic(undefined), null);
  assert.equal(parseBasic('Basic ' + Buffer.from('没有冒号').toString('base64')), null);
});

await t('safeEqual 长度不同也不抛(长度不是秘密,但不能崩)', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

await t('没设 PANEL_PASS 时随机生成而不是放行', () => {
  const c = resolveCredentials({ PANEL_USER: 'u' });
  assert.equal(c.generated, true);
  assert.ok(c.pass.length >= 12, '随机密码不能短到能猜');
  assert.notEqual(resolveCredentials({}).pass, resolveCredentials({}).pass);
  assert.equal(resolveCredentials({ PANEL_PASS: 'x' }).generated, false);
  assert.equal(resolveCredentials({}).user, 'admin');
});

await t('matches:用户名或密码错一个都不算过', () => {
  const c = { user: 'admin', pass: 'p' };
  assert.equal(matches(c, 'admin', 'p'), true);
  assert.equal(matches(c, 'admin', 'x'), false);
  assert.equal(matches(c, 'root', 'p'), false);
  assert.equal(matches(c, '', ''), false);
  assert.equal(matches(undefined, '', ''), false, '凭据没解析出来时不能变成放行');
});

await t('readCookie 只认整名,前后空白不算内容', () => {
  assert.equal(readCookie('a=1; ciallo_sid=abc; b=2', 'ciallo_sid'), 'abc');
  assert.equal(readCookie('ciallo_sid=abc', 'ciallo_sid'), 'abc');
  assert.equal(readCookie('ciallo_sid_x=abc', 'ciallo_sid'), '', '不能前缀匹配到别的 cookie');
  assert.equal(readCookie('flag; ciallo_sid=v', 'ciallo_sid'), 'v', '没等号的段落跳过,不能崩');
  assert.equal(readCookie('', 'ciallo_sid'), '');
  assert.equal(readCookie(undefined, 'ciallo_sid'), '');
});

await t('会话:id 各不相同,过期和退出都当场失效', () => {
  const s = new Sessions(1000);
  const a = s.issue(0);
  assert.notEqual(a, s.issue(0));
  assert.ok(a.length >= 32, 'id 得够长 —— 它就是密码本身,能猜到就等于没鉴权');
  assert.equal(s.valid(a, 999), true);
  assert.equal(s.valid(a, 1000), false, '到点就失效');
  assert.equal(s.valid('', 0), false);
  assert.equal(s.valid('伪造的', 0), false);

  const b = s.issue(0);
  assert.equal(s.drop(b), true);
  assert.equal(s.valid(b, 0), false, '退出登录后那张 cookie 不能还认');

  s.issue(5000);   // 过期项在下一次签发时被扫掉,表不会一直长
  assert.equal(s.live.size, 1);
});

await t('失败限速:连错到上限就挡住,校验成功立刻清零', () => {
  const w = new FailWindow(3, 1000);
  w.fail(0); w.fail(0);
  assert.equal(w.retryIn(0), 0, '没到上限不挡');
  w.fail(0);
  assert.equal(w.retryIn(0), 1000, '到上限,等窗口过完');
  assert.equal(w.retryIn(600), 400, '等待时间跟着时间走');
  assert.equal(w.retryIn(1000), 0, '窗口滑过去就放开');

  w.fail(2000); w.fail(2000); w.fail(2000);
  assert.ok(w.retryIn(2000) > 0);
  w.pass();
  assert.equal(w.retryIn(2000), 0, '密码对了就清零 —— 不然有人在外面爆破会把自己也锁在门外');
});

// ── CONNECT 隧道(回归 proxy 选项那个 bug) ───────────────

await t('connectTunnel 真的发 CONNECT,并把隧道后的字节还回来', async () => {
  let seen = '';
  const fake = net.createServer((sock) => {
    sock.once('data', (c) => {
      seen = c.toString();
      // 故意把 200 和后续字节粘在一个包里:真代理会这么干,
      // 实现必须把多出来的部分 unshift 回去,不然 TLS 握手数据被吞
      sock.write('HTTP/1.1 200 Connection established\r\n\r\nEXTRA');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;

  const sock = await connectTunnel({ proxyPort: port, host: 'opencode.ai', port: 443 });
  assert.match(seen, /^CONNECT opencode\.ai:443 HTTP\/1\.1\r\n/, '请求行不对代理会拒绝');
  assert.match(seen, /Host: opencode\.ai:443/);
  const first = await new Promise((r) => sock.once('data', (c) => r(c.toString())));
  assert.equal(first, 'EXTRA', '粘在响应头后面的字节必须还给上层');
  sock.destroy();
  fake.close();
});

await t('代理拒绝时报错而不是当成成功', async () => {
  const fake = net.createServer((s) => s.once('data', () => s.write('HTTP/1.1 403 Forbidden\r\n\r\n')));
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  await assert.rejects(
    connectTunnel({ proxyPort: fake.address().port, host: 'x.com' }),
    /HTTP 403/,
  );
  fake.close();
});

await t('mihomo 没起来时报连不上,而不是静默直连', async () => {
  // 关键行为:代理不可用时必须失败。原 bug 就是这种情况下悄悄走了直连,
  // 出口 IP 变成本机,换节点全白干。
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const dead = probe.address().port;
  await new Promise((r) => probe.close(r));
  await assert.rejects(connectTunnel({ proxyPort: dead, host: 'x.com' }), /连不上 mihomo/);
});

// ── 构建标识与检查更新 ──────────────────────────────────

/** 假的 fetch:只关心 checkUpdate 怎么解释响应,不真打 api.github.com
 *  (会算进匿名限流,CI 上还会因为网络抽风变成假失败) */
const fakeFetch = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (typeof body === 'string') throw new Error('not json');
    return body;
  },
});

await t('shortSha 把 40 位截成 7 位,认不出的原样留着', () => {
  assert.equal(shortSha('A'.repeat(40)), 'a'.repeat(7));
  assert.equal(shortSha('  9dfba5612345 \n'), '9dfba56');
  assert.equal(shortSha('unknown'), '', '「unknown」是没拿到,不是一个版本号');
  assert.equal(shortSha(''), '');
  assert.equal(shortSha(undefined), '');
  assert.equal(shortSha('v1.2.3'), 'v1.2.3', '不像 hash 的照原样,截了反而认不出');
});

await t('buildId 优先取环境变量(容器里就靠它)', () => {
  assert.equal(buildId(), 'a'.repeat(7), 'GIT_COMMIT 设了就不该再去问 git');
  const info = buildInfo();
  assert.equal(info.build, 'a'.repeat(7));
  assert.match(info.buildUrl, /\/commit\/a{7}$/, 'hash 得链到那次 commit');
  assert.match(info.repoUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  assert.equal(info.trackRef, 'beta', '代码和 latest 镜像都出自 beta');
});

await t('checkUpdate:hash 一样就是最新', async () => {
  const r = await checkUpdate(fakeFetch(200, { sha: 'a'.repeat(40), html_url: 'u', commit: {} }));
  assert.equal(r.latest, 'a'.repeat(7));
  assert.equal(r.hasUpdate, false);
  assert.equal(r.error, null);
});

await t('checkUpdate:hash 不一样就是有新版本,并带上提交时间', async () => {
  const r = await checkUpdate(fakeFetch(200, {
    sha: 'b'.repeat(40),
    html_url: 'https://github.com/x/y/commit/bbb',
    commit: { committer: { date: '2026-08-06T10:00:00Z' } },
  }));
  assert.equal(r.hasUpdate, true);
  assert.equal(r.latest, 'b'.repeat(7));
  assert.equal(r.current, 'a'.repeat(7));
  assert.equal(r.publishedAt, '2026-08-06T10:00:00Z');
  assert.match(r.htmlUrl, /commit\/bbb$/);
});

await t('checkUpdate:限流、404、非 JSON、断网都回 error 而不是抛', async () => {
  const rate = await checkUpdate(fakeFetch(403, {}));
  assert.match(rate.error, /限流/, '403 几乎总是匿名配额用完,别让人去查代理');
  assert.equal(rate.hasUpdate, false);

  assert.match((await checkUpdate(fakeFetch(404, {}))).error, /不存在/);
  assert.match((await checkUpdate(fakeFetch(500, {}))).error, /HTTP 500/);
  assert.match((await checkUpdate(fakeFetch(200, 'not json'))).error, /不是 JSON/);
  assert.match((await checkUpdate(fakeFetch(200, { sha: '' }))).error, /sha/);

  const down = await checkUpdate(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  assert.match(down.error, /ENOTFOUND/, '原始网络错误要能显示出来,不然没法判断是墙还是 DNS');
  assert.equal(down.current, 'a'.repeat(7), '查不到远端也得把本地 hash 报出来');
});

await t('本地 hash 不明时不谎报「有新版本」', async () => {
  // 带 query 重新 import 拿一个干净的模块实例(buildId 有模块级缓存)。
  // 这是唯一能在同一个进程里试两种 GIT_COMMIT 的办法。
  process.env.GIT_COMMIT = 'dev';
  const mod = await import('../server/build.mjs?nonsha');
  assert.equal(mod.buildId(), 'dev');
  const r = await mod.checkUpdate(fakeFetch(200, { sha: 'c'.repeat(40), commit: {} }));
  assert.equal(r.hasUpdate, false, '构建时没注入 hash,新旧无从判断,报了就是让人白拉一次镜像');
  assert.equal(r.latest, 'c'.repeat(7), '但远端 hash 照样告诉前端');
  process.env.GIT_COMMIT = 'a'.repeat(40);
});

// ── Responses 方言(近乎透传,但有两处非做不可的薄处理)──────────

await t('readUsage 两套命名都认:Responses 的 input/output_tokens 归一到 prompt/completion', () => {
  const r = readUsage({ input_tokens: 12, output_tokens: 5, total_tokens: 17 });
  assert.equal(r.promptTokens, 12, 'input_tokens 要落到 promptTokens,否则面板显示 0');
  assert.equal(r.completionTokens, 5);
  assert.equal(r.totalTokens, 17);
});

await t('readUsage:上游明确报的 0 不能被另一套命名顶掉', () => {
  // prompt_tokens 存在且为 0(?? 只在 null/undefined 时才回落),不能被 input_tokens 覆盖
  const r = readUsage({ prompt_tokens: 0, input_tokens: 99, completion_tokens: 3 });
  assert.equal(r.promptTokens, 0, '?? 语义:显式 0 是有意义的值');
  assert.equal(r.completionTokens, 3);
});

await t('readUsage:Responses 的 reasoning/cache 明细字段也认', () => {
  const r = readUsage({
    input_tokens: 10, output_tokens: 8,
    output_tokens_details: { reasoning_tokens: 6 },
    input_tokens_details: { cached_tokens: 4 },
  });
  assert.equal(r.reasoningTokens, 6, 'output_tokens_details.reasoning_tokens 要认');
  assert.equal(r.cacheReadTokens, 4, 'input_tokens_details.cached_tokens 要认');
  assert.equal(r.hasCacheData, true);
});

await t('RESPONSES.validate:input 数组或非空字符串放行,缺了才 400', () => {
  assert.equal(RESPONSES.validate({ input: [{ role: 'user', content: 'hi' }] }), null);
  assert.equal(RESPONSES.validate({ input: 'hi' }), null, 'OpenAI SDK 允许字符串 input');
  assert.equal(typeof RESPONSES.validate({ input: [] }), 'string', '空数组要挡');
  assert.equal(typeof RESPONSES.validate({ input: '  ' }), 'string', '空白字符串要挡');
  assert.equal(typeof RESPONSES.validate({}), 'string', '缺 input 要挡');
  // messages 不是 Responses 的字段,给了也不算数
  assert.equal(typeof RESPONSES.validate({ messages: [{ role: 'user', content: 'x' }] }), 'string');
});

await t('RESPONSES.toUpstream:字符串 input 补成上游要的数组,数组原样透传', () => {
  const wrapped = RESPONSES.toUpstream({ model: 'm', input: 'hi' });
  assert.deepEqual(wrapped.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    '纯字符串上游会 400 Empty input messages,必须补成数组');
  const arr = [{ role: 'user', content: [{ type: 'input_text', text: 'a' }] }];
  assert.equal(RESPONSES.toUpstream({ model: 'm', input: arr }).input, arr, '数组不动它');
});

await t('RESPONSES.applyEffort:走嵌套 reasoning.effort,不碰顶层 reasoning_effort', () => {
  const body = { model: 'm', input: [] };
  RESPONSES.applyEffort(body, 'high');
  assert.deepEqual(body.reasoning, { effort: 'high' }, 'Responses 认嵌套字段,塞顶层上游会忽略');
  assert.ok(!('reasoning_effort' in body), '别注入 chat 那套顶层字段');

  // 保留客户端已带的其它 reasoning 字段(如 summary),只改 effort
  const withSummary = { model: 'm', input: [], reasoning: { summary: 'auto' } };
  RESPONSES.applyEffort(withSummary, 'medium');
  assert.deepEqual(withSummary.reasoning, { summary: 'auto', effort: 'medium' });

  // 空档位:删掉 effort;删到空对象就把 reasoning 整个去掉,不发空壳
  const empty = { model: 'm', input: [], reasoning: { effort: 'low' } };
  RESPONSES.applyEffort(empty, '');
  assert.ok(!('reasoning' in empty), 'reasoning 只剩空对象时整个删掉');
  const keep = { model: 'm', input: [], reasoning: { summary: 'auto', effort: 'low' } };
  RESPONSES.applyEffort(keep, '');
  assert.deepEqual(keep.reasoning, { summary: 'auto' }, '还有别的字段就只删 effort');
});

/** 把 sink 的转发结果收集成字符串,断言用(sink 只用到 res.write/end) */
function collectSink(dialect) {
  const out = { chunks: [], ended: false };
  const res = { write: (c) => { out.chunks.push(String(c)); return true; }, end: () => { out.ended = true; } };
  return { sink: dialect.sink(res), out, text: () => out.chunks.join('') };
}

await t('responsesSink:response.* 事件原样透传,收尾漏出的 chat.completion.chunk 吞掉', () => {
  const { sink, text } = collectSink(RESPONSES);
  sink.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}\n\n`);
  sink.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
  // 漏块型模型(deepseek/hy3)收尾会漏这个原始 chat 块,严格 Responses 客户端会解析报错
  sink.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
  sink.write('data: [DONE]\n\n');
  sink.end();

  const s = text();
  assert.ok(s.includes('response.output_text.delta'), '正文事件必须转发');
  assert.ok(s.includes('response.completed'), 'completed 必须转发');
  assert.ok(!s.includes('chat.completion.chunk'), '漏出来的 chat 杂块必须吞掉');
  assert.ok(s.includes('[DONE]'), '[DONE] 原样透传');
});

await t('responsesSink:半个事件跨 chunk 到达时不丢内容、也不误伤', () => {
  const { sink, text } = collectSink(RESPONSES);
  const line = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'xyz' })}\n\n`;
  sink.write(line.slice(0, 15));      // 断在中间
  sink.write(line.slice(15));
  sink.end();
  assert.ok(text().includes('"delta":"xyz"'), '缓冲区必须留住半行等下一块');
  assert.ok(text().includes('response.output_text.delta'));
});

await t('responsesSink:chat 杂块跨 chunk 到达也照样吞掉', () => {
  const { sink, text } = collectSink(RESPONSES);
  const junk = `data: ${JSON.stringify({ object: 'chat.completion.chunk', usage: { prompt_tokens: 2 } })}\n\n`;
  sink.write(junk.slice(0, 30));
  sink.write(junk.slice(30));
  sink.end();
  assert.ok(!text().includes('chat.completion.chunk'), '分片重组后仍要认出并吞掉');
});

// ── 把真 server 拉起来打一遍 ────────────────────────────

const cfg = load();
const creds = { user: 'tester', pass: 'test-pass', generated: false };
const gateway = new Gateway(cfg, () => {});
// 别让测试真的出站去拉模型清单:/api/status 每次都会顺手起一次刷新,
// 有没有内核、能不能连上游都不该影响断言
gateway.upstreamGet = async () => { throw new Error('测试不出站'); };
const subscriptionSchedules = [];
const app = createApp({
  cfg, creds, gateway,
  subscriptionUpdater: { schedule: (hours) => subscriptionSchedules.push(hours) },
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;
const auth = 'Basic ' + Buffer.from('tester:test-pass').toString('base64');
let cookie = '';                  // 登录那组测试里拿到的会话,后面几组接着用

/** 现登一个会话。页面路径只认 cookie,而上面那个 `cookie` 会被退出登录那组作废 */
async function login() {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'tester', pass: 'test-pass' }),
  });
  await r.text();
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

await t('/health 不要凭据(docker healthcheck 得进得来)', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  // 不再报单一模型名 —— 模型是客户端选的,这里只说清单里有几个
  assert.equal(j.model, undefined, '固定模型这个概念已经没有了,别让它复活');
  assert.equal(j.models, FREE_MODELS.length);
});

await t('匿名:页面跳登录页,/api/* 给 401,而且哪儿都不发 WWW-Authenticate', async () => {
  for (const p of ['/', '/index.html', '/app.js']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.equal(r.status, 302, `${p} 该跳登录页而不是 ${r.status} —— 这里会明文吐订阅凭据`);
    assert.equal(r.headers.get('location'), '/login');
    assert.equal(r.headers.get('www-authenticate'), null, '有这个头浏览器就弹框,而弹框正是要去掉的东西');
    await r.text();
  }
  for (const p of ['/api/config', '/api/status', '/api/nodes', '/api/logs']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 401, `${p} 应该 401 而不是 ${r.status}`);
    assert.equal(r.headers.get('www-authenticate'), null);
    // 302 到一坨 HTML 的话 fetch 只会报解析失败,前端得拿到 401 才知道去跳登录页
    assert.match((await r.json()).error, /未登录/);
  }
});

await t('POST 到页面路径给 404 JSON,绝不能 302 成一坨登录页 HTML', async () => {
  // 反代把 base URL 配错(少个 /v1)时打的就是 /chat/completions。跟着 302
  // 会拿到 200 + 登录页,对面认为调用成功,把 HTML 当模型回答转出去 —— 实测踩过。
  for (const p of ['/chat/completions', '/messages', '/nope']) {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual',
    });
    assert.equal(r.status, 404, `POST ${p} 该 404 而不是 ${r.status}`);
    const j = await r.json();
    assert.match(j.error, /Not found/, '得是 JSON 错误体,不是 HTML');
  }
  // 跟着跳转也一样:整条链路上不该有任何一步拿得到 200
  const followed = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(followed.status, 404);
  assert.ok(!(await followed.text()).includes('<!DOCTYPE'), 'HTML 漏出去就是这个 bug 本身');
});

await t('登录页和它引的两个文件不要凭据(不然只能看到一张白纸)', async () => {
  for (const p of ['/login', '/style.css', '/login.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, `${p} 得能匿名拿到`);
    await r.text();
  }
});

await t('登录:密码错不发 cookie,对了发一个 HttpOnly 的', async () => {
  const bad = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'tester', pass: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null, '密码错了绝不能发会话');
  await bad.text();

  const ok = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'tester', pass: 'test-pass' }),
  });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie') || '';
  assert.match(sc, /^ciallo_sid=[\w-]{20,}/);
  assert.match(sc, /HttpOnly/i, '脚本读得到会话就等于 XSS 能把它偷走');
  assert.match(sc, /SameSite=Lax/i, '跨站 POST 不能带上它 —— 有副作用的路由全是 POST');
  assert.ok(!/Secure/i.test(sc), '本地是 http,加了 Secure 浏览器会直接把 cookie 丢掉');
  await ok.text();
  cookie = sc.split(';')[0];
});

await t('带会话 cookie 就能读面板,不用再带 Basic', async () => {
  const r = await fetch(`${base}/api/status`, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).gatewayRunning, true);

  const page = await fetch(base + '/', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>/);

  // 已经登录了还去 /login 没意义,跳回面板
  const back = await fetch(`${base}/login`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/');
  await back.text();
});

await t('退出登录后那张 cookie 当场不认(不是等它自己过期)', async () => {
  const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/, '还得让浏览器把它删掉');
  await out.text();

  const after = await fetch(`${base}/api/status`, { headers: { cookie } });
  assert.equal(after.status, 401, '服务端没作废的话,cookie 被复制走就一直能用');
  await after.text();
});

// 用过老版本的浏览器还缓存着弹框那次收到的 Basic 凭据,并且会一直主动带上。
// 页面也认 Basic 的话,退出登录后 location.replace('/login') 又被 302 回面板 ——
// 点了像没反应。这一组就是那个 bug 的回归测试。
await t('页面只认会话 cookie:浏览器缓存的 Basic 顶不开面板,也顶不掉退出登录', async () => {
  for (const p of ['/', '/index.html']) {
    const r = await fetch(base + p, { headers: { authorization: auth }, redirect: 'manual' });
    assert.equal(r.status, 302, `${p} 带 Basic 也该跳登录页,不然「退出登录」退不掉`);
    assert.equal(r.headers.get('location'), '/login');
    await r.text();
  }
  const page = await fetch(`${base}/login`, { headers: { authorization: auth }, redirect: 'manual' });
  assert.equal(page.status, 200, '/login 带 Basic 不能被弹回面板 —— 那就是「登出没反应」');
  await page.text();

  // 但脚本那条路不受影响:/api/* 照旧认 Basic
  const api = await fetch(`${base}/api/status`, { headers: { authorization: auth } });
  assert.equal(api.status, 200, 'README 里 /api/* 的 curl 用法不能被这条规则连带打死');
  await api.text();
});

await t('密码错也是 401,不是 500', async () => {
  const bad = 'Basic ' + Buffer.from('tester:wrong').toString('base64');
  const r = await fetch(`${base}/api/config`, { headers: { authorization: bad } });
  assert.equal(r.status, 401);
  await r.text();
});

await t('带对凭据能读到配置和状态', async () => {
  const r = await fetch(`${base}/api/config`, { headers: { authorization: auth } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ['apiKey', 'opencodeIdentityHeaders', 'port', 'subscriptionUpdateHours', 'subscriptionUrl'], '字段形状是前端契约,不能改');
  assert.equal(j.opencodeIdentityHeaders, false, '请求头开关默认关');
  assert.equal(j.subscriptionUpdateHours, 1, '保持旧版每小时自动更新的默认行为');

  const s = await (await fetch(`${base}/api/status`, { headers: { authorization: auth } })).json();
  assert.equal(s.fixedModel, undefined, '固定模型已废,留着这个字段会让前端以为还能靠它');
  assert.equal(s.mihomoRunning, false, '测试环境没有内核,应老实报 false');
  assert.equal(s.gatewayRunning, true);
  // 免费模型清单也搭这趟车。这里出不了站,所以看到的必然是兜底那份 ——
  // 要验的是这个字段一定在、一定非空:前端已经不留本地常量了
  assert.deepEqual(s.models, FREE_MODELS);
  // 构建标识搭 /api/status 的车过去,面板右上角那个徽标全靠这几个字段
  assert.equal(s.build, 'a'.repeat(7));
  assert.match(s.buildUrl, /^https:\/\/github\.com\/.+\/commit\/a{7}$/);
  assert.match(s.repoUrl, /^https:\/\/github\.com\//);
  assert.equal(s.trackRef, 'beta');
});

await t('/v1/* 认 Bearer 而不是 Basic', async () => {
  const noKey = await fetch(`${base}/v1/models`);
  assert.equal(noKey.status, 401);
  await noKey.text();

  // Basic 在这条路径上不算凭据
  const wrongScheme = await fetch(`${base}/v1/models`, { headers: { authorization: auth } });
  assert.equal(wrongScheme.status, 401);
  await wrongScheme.text();

  const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.object, 'list');
  assert.ok(j.data.some((m) => m.id === 'deepseek-v4-flash-free'));
});

await t('没节点时 chat 返回 503 而不是挂住', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODELS[0], messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.type, 'no_nodes');
});

// ── Responses 路由(POST /v1/responses)──────────────────

await t('没节点时 /v1/responses 也回 503,证明路由接上了、input 校验放行', async () => {
  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODELS[0], input: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.type, 'no_nodes', '错误体是 OpenAI 同形 {error:{type}}');
});

await t('/v1/responses 缺 input:400,而不是打到上游', async () => {
  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODELS[0] }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.type, 'invalid_request_error');
});

await t('/v1/responses 模型不在免费清单:400 invalid_model', async () => {
  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5-turbo-ultra', input: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.type, 'invalid_model');
  assert.match(j.error.message, /gpt-5-turbo-ultra/);
});

await t('/v1/responses 认 Bearer,不带 Key 是 401(OpenAI 形状的错误体)', async () => {
  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODELS[0], input: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.type, 'authentication_error');
});

// ── 严格模型透传 ────────────────────────────────────────

await t('模型不在免费清单:400 invalid_model,而且一个字节都不出站', async () => {
  // 这条比「有没有 400」更重要:以前的行为是静默改写成固定模型,
  // 客户端拿到的是另一个模型的回答却毫不知情
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5-turbo-ultra', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400, '没节点也该先在这儿挡下 —— 校验在选节点之前');
  const j = await r.json();
  assert.equal(j.error.type, 'invalid_model');
  assert.match(j.error.message, /gpt-5-turbo-ultra/, '得说清是哪个模型被拒了');
});

await t('缺 model:400,不给默认值顶上', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.type, 'invalid_request_error');
});

await t('Anthropic 侧同样挡,但错误体得是 Anthropic 那套', async () => {
  // invalid_model 是 OpenAI 的说法,Anthropic SDK 读不懂,得映射成
  // invalid_request_error —— 否则客户端把畸形响应翻译成「模型不存在或没权限」
  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: '不存在的模型', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'invalid_request_error');
  assert.match(j.error.message, /不存在的模型/);
});

await t('POST 改端口无效(不然面板会显示一个连不上的接入地址)', async () => {
  const before = cfg.port;
  const r = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ port: 12345 }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).port, before, '端口由 compose 映射决定,进程说了不算');
  assert.equal(cfg.port, before);
});

await t('单独切身份头:已有订阅也不刷新、不测速、不重启内核', async () => {
  const oldSub = cfg.subscriptionUrl;
  cfg.subscriptionUrl = 'https://sub.example/existing';
  let updates = 0, reads = 0, tests = 0;
  const savedUpdate = gateway.updateProvider;
  const savedGetAll = gateway.getAllNodes;
  const savedTest = gateway.testNodes;
  gateway.updateProvider = async () => { updates++; };
  gateway.getAllNodes = async () => { reads++; return ['A']; };
  gateway.testNodes = async () => { tests++; return {}; };

  try {
    const beforeSchedules = subscriptionSchedules.length;
    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ opencodeIdentityHeaders: true }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).opencodeIdentityHeaders, true);
    assert.equal(cfg.opencodeIdentityHeaders, true, '同一个 cfg 对象,下一个请求就用上了');
    assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8')).opencodeIdentityHeaders, true,
      '得落盘,不然重启就回到关闭');
    assert.deepEqual({ updates, reads, tests }, { updates: 0, reads: 0, tests: 0 },
      '请求体没带 subscriptionUrl 时不能借旧地址触发任何订阅操作');
    assert.equal(subscriptionSchedules.length, beforeSchedules,
      '只切请求头不能重排自动更新,否则下一次更新时间会被无故向后顺延');
  } finally {
    gateway.updateProvider = savedUpdate;
    gateway.getAllNodes = savedGetAll;
    gateway.testNodes = savedTest;
    cfg.subscriptionUrl = oldSub;
  }

  // 关回去,别影响后面几组
  await (await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ opencodeIdentityHeaders: false }),
  })).text();
  assert.equal(cfg.opencodeIdentityHeaders, false);
});

await t('旧 config.json 没有身份头字段也能加载,默认关闭', () => {
  // 升级上来的实例配置文件里没这个键。缺了得当「关闭」,而不是 undefined ——
  // undefined 在 reqOpts 那个三元里虽然也走 false 分支,但面板的 checkbox
  // 会显示成未定态,而且下次保存会把 undefined 写进文件
  const f = path.join(TMP, 'config.json');
  const saved = fs.readFileSync(f, 'utf8');
  const old = JSON.parse(saved);
  delete old.opencodeIdentityHeaders;
  fs.writeFileSync(f, JSON.stringify(old));
  try {
    const c = load();
    assert.equal(c.opencodeIdentityHeaders, false, '默认必须是关的 —— 这是个实验开关');
    assert.equal(c.apiKey, old.apiKey, '其余字段照原样读出来,不重新生成');
  } finally {
    fs.writeFileSync(f, saved);
  }
});

await t('保存非法订阅地址和自动更新小时数被挡下', async () => {
  for (const body of [
    { subscriptionUrl: 'ftp://nope' },
    { subscriptionUpdateHours: -1 },
    { subscriptionUpdateHours: 1.5 },
    { subscriptionUpdateHours: 8761 },
  ]) {
    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
    await r.text();
  }

  const before = cfg.opencodeIdentityHeaders;
  const mixed = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ opencodeIdentityHeaders: !before, subscriptionUpdateHours: -1 }),
  });
  assert.equal(mixed.status, 400);
  await mixed.text();
  assert.equal(cfg.opencodeIdentityHeaders, before, '请求有非法字段时不能先应用同请求里的其他配置');
});

await t('保存自动更新小时数立即重排,且不刷新订阅或测速', async () => {
  const seen = [];
  const localCfg = { ...cfg, subscriptionUrl: 'https://sub.example/existing', subscriptionUpdateHours: 0 };
  const localGateway = new Gateway(localCfg, () => {});
  let updates = 0, tests = 0;
  localGateway.updateProvider = async () => { updates++; };
  localGateway.testNodes = async () => { tests++; };
  const localApp = createApp({
    cfg: localCfg, creds, gateway: localGateway,
    subscriptionUpdater: { schedule: (hours) => seen.push(hours) },
  });
  await new Promise((r) => localApp.listen(0, '127.0.0.1', r));
  try {
    const localBase = `http://127.0.0.1:${localApp.address().port}`;
    const r = await fetch(`${localBase}/api/config`, {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ subscriptionUpdateHours: 12 }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).subscriptionUpdateHours, 12);
    assert.deepEqual(seen, [12]);
    assert.deepEqual({ updates, tests }, { updates: 0, tests: 0 }, '保存周期本身不能立刻重拉,只重排下一次计划');
  } finally {
    await new Promise((r) => localApp.close(r));
  }
});

await t('换 Key 立刻生效,旧 Key 立刻失效', async () => {
  const old = cfg.apiKey;
  const r = await fetch(`${base}/api/regen-key`, { method: 'POST', headers: { authorization: auth } });
  const { apiKey } = await r.json();
  assert.notEqual(apiKey, old);
  const stale = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${old}` } });
  assert.equal(stale.status, 401, '旧 Key 必须当场失效,不能等重启');
  await stale.text();
  const fresh = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(fresh.status, 200);
  await fresh.text();
});

await t('静态目录穿越拿不到 web 之外的文件', async () => {
  // 得带真会话:页面路径不认 Basic 了,拿 Basic 打会被 302 到 /login,
  // fetch 默认跟着跳转回 200 —— 那测的是重定向,不是穿越防护。
  const r = await fetch(`${base}/../package.json`, {
    headers: { cookie: await login() }, redirect: 'manual',
  });
  assert.ok(r.status === 404 || r.status === 403, `应拒绝,得到 ${r.status}`);
  await r.text();
});

// ── 两种方言的鉴权和错误体 ──────────────────────────────

await t('x-api-key 也认(Anthropic 客户端不发 Bearer)', async () => {
  // 这是实测踩到的坑:只认 Bearer 时 /v1/messages 对每个 Anthropic 客户端
  // 都是 401,而客户端把 401 显示成"模型不存在或你没有权限",排查方向全歪
  const r = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': cfg.apiKey } });
  assert.equal(r.status, 200, 'x-api-key 必须能过');
  await r.text();
});

await t('x-api-key 错了照样 401', async () => {
  const r = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'wrong' } });
  assert.equal(r.status, 401);
  await r.text();
});

await t('/v1/messages 的错误体是 Anthropic 形状,不是 OpenAI 的', async () => {
  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 401);
  const b = await r.json();
  // SDK 读的是 body.error.type,给它 OpenAI 那套它认不出来
  assert.equal(b.type, 'error');
  assert.equal(b.error.type, 'authentication_error');
  assert.ok(!('message' in b), 'Anthropic 错误体没有顶层 message');
});

await t('/v1/chat/completions 的错误体仍是 OpenAI 形状', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(r.status, 401);
  const b = await r.json();
  assert.equal(typeof b.error.message, 'string');
  assert.ok(!b.type, '不能把 Anthropic 的壳套到 OpenAI 客户端上');
});

await t('没节点时 /v1/messages 回 503 且形状正确', async () => {
  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODELS[0], max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 503);
  const b = await r.json();
  assert.equal(b.type, 'error');
  assert.equal(b.error.type, 'overloaded_error');
});

await t('messages 为空时 400,而不是打到上游', async () => {
  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODELS[0], max_tokens: 10, messages: [] }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.type, 'invalid_request_error');
});

await t('count_tokens 给得出数(缺这个路由 Claude Code 起不来)', async () => {
  const r = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }] }),
  });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.ok(Number.isInteger(b.input_tokens) && b.input_tokens > 0, `要一个正整数,得到 ${b.input_tokens}`);
});

await t('未知的 /v1/ 路径按方言回 404', async () => {
  const r = await fetch(`${base}/v1/nope`, { headers: { 'x-api-key': cfg.apiKey } });
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error.message.includes('/v1/nope'));
});

// ── 节点池与统计的面板接口 ──────────────────────────────
// 放在最后:这里会替掉 gateway 上的取节点方法,前面那些「没节点」的断言
// 必须在替换之前跑完

await t('/api/nodes 给出排过序的表、剔除名单和延迟', async () => {
  gateway.getAllNodes = async () => ['A', 'B', 'C'];
  gateway.getCurrentNode = async () => 'B';
  gateway.delay = new Map([['A', 300], ['B', 80], ['C', null]]);
  gateway.testedAt = 1_700_000_000_000;

  const j = await (await fetch(`${base}/api/nodes`, { headers: { authorization: auth } })).json();
  assert.deepEqual(j.nodes, ['B', 'A'], '面板显示的顺序必须就是网关取用的顺序');
  assert.deepEqual(j.excluded, ['C'], '剔掉的也要报出来,静默消失像是订阅少了节点');
  assert.deepEqual(j.delay, { A: 300, B: 80, C: null });
  assert.equal(j.testedAt, 1_700_000_000_000);
  assert.equal(j.testing, false);
  assert.equal(j.current, 'B');
});

await t('POST /api/nodes/test 触发测延迟并回摘要', async () => {
  gateway.mihomoApi = async (p) => {
    const m = decodeURIComponent(p).match(/^\/proxies\/(.+?)\/delay/);
    if (!m) return { all: ['A', 'B'], now: 'A' };
    if (m[1] === 'B') throw new Error('HTTP 503');
    return { delay: 120 };
  };
  const r = await fetch(`${base}/api/nodes/test`, { method: 'POST', headers: { authorization: auth } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tested, 3, 'getAllNodes 被前面的测试替过,这里测的是它给的 3 个');
  assert.equal(typeof j.ms, 'number');
});

await t('POST /api/models/sync 现拉一遍清单并回变更明细', async () => {
  gateway.models = ['old-free'];
  gateway.modelsAt = 0;
  gateway.upstreamGet = async () => ({ data: [{ id: 'old-free' }, { id: 'new-free' }] });

  const r = await fetch(`${base}/api/models/sync`, { method: 'POST', headers: { authorization: auth } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.models, ['old-free', 'new-free']);
  assert.deepEqual(j.added, ['new-free'], 'toast 要说出新增了哪个,不然看不出这次到底拉到了没有');
  assert.deepEqual(j.gone, []);
});

await t('拉不到时 /api/models/sync 回 500 而不是假装成功', async () => {
  gateway.models = ['old-free'];
  gateway.modelsAt = 0;
  gateway.upstreamGet = async () => { throw new Error('ECONNREFUSED'); };

  const r = await fetch(`${base}/api/models/sync`, { method: 'POST', headers: { authorization: auth } });
  assert.equal(r.status, 500, '手动点的按钮必须把失败报出来 —— 回 200 + 旧清单看着像同步成功了');
  const j = await r.json();
  assert.match(j.error, /ECONNREFUSED/);
  assert.deepEqual(gateway.freeModels(), ['old-free'], '失败不改清单');
});

await t('GET /api/models/sync 不算数(会出站的都是 POST)', async () => {
  const r = await fetch(`${base}/api/models/sync`, { headers: { authorization: auth } });
  assert.equal(r.status, 404, '浏览器预取或缓存不该触发一次出站');
  await r.text();
});

await t('POST /api/usage/reset 清零并落盘', async () => {
  gateway.usage.record('m', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, true);
  assert.ok(gateway.usage.getStats().total.requests > 0, '先得有数才测得出清零');

  const r = await fetch(`${base}/api/usage/reset`, { method: 'POST', headers: { authorization: auth } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.total.requests, 0);
  assert.deepEqual(j.byModel, {});
  assert.equal(j.lastRequest, null);

  const after = await (await fetch(`${base}/api/usage`, { headers: { authorization: auth } })).json();
  assert.equal(after.total.totalTokens, 0);
});

await t('GET /api/usage/reset 不算数(清零只能是 POST)', async () => {
  const r = await fetch(`${base}/api/usage/reset`, { headers: { authorization: auth } });
  assert.equal(r.status, 404, '误点一个链接不该把统计清了');
  await r.text();
});

await new Promise((r) => app.close(r));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\nserver.mjs: 全部通过 (${n} 组)\n`);
