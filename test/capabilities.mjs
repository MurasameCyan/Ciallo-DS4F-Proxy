/**
 * capabilities.mjs —— 模型能力记录的自检。
 *
 * 探测这件事分两半:发请求(贵,要真出站)和读上游的错误原文(不花钱,但会错)。
 * 所以三个解析函数单独导出、单独测;探测编排那部分喂一个假 post,连 HTTP 都不起。
 *
 * 重点是「探不到的时候会怎样」——「探到了」是顺路的:探不到时静默按默认值跑,
 * 正是这套东西要根治的那个坑(见 anthropic.mjs 的 MODEL_EFFORTS)。
 *
 * 跑:node test/capabilities.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  Capabilities, SEED, LADDER, effortMapOf, parseEfforts, parseMaxOut, parseCtx, CTX_CANDIDATES,
} = await import('../server/capabilities.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-caps-'));
const tmpFile = (name) => path.join(TMP, name);

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// ── 解析 ────────────────────────────────────────────────

await t('parseEfforts 从错误原文里读出档位,按词边界而不是子串', () => {
  assert.deepEqual(
    parseEfforts('[1210] This model always engages in thinking and cannot be disabled; please use low, high, or max'),
    ['low', 'high', 'max'],
  );
  // xhigh 里含着 high —— 子串匹配会把「只认 xhigh」读成「认 high」,
  // 于是 clampEffort 把 xhigh 夹成 high,静默降一档
  assert.deepEqual(parseEfforts('use xhigh only'), ['xhigh']);
  assert.deepEqual(parseEfforts('supported: minimal, medium'), ['minimal', 'medium']);
  // 返回顺序是 LADDER 的顺序,不是原文里出现的顺序 —— clampEffort 靠这个找「更强的下一档」
  assert.deepEqual(parseEfforts('max or low'), ['low', 'max']);
  // 一个档位词都没有 = 没读出来。null 表示「按宽松处理」,退回有记录之前的行为,
  // 而不是把「不认任何档位」这种假结论写进记录
  assert.equal(parseEfforts('Internal server error'), null);
  assert.equal(parseEfforts(''), null);
  assert.equal(parseEfforts(null), null);
});

await t('parseMaxOut 认中英文两种上限写法', () => {
  assert.equal(parseMaxOut('[1210] The max_tokens parameter is illegal.:限制数值范围[1,131072]'), 131072);
  assert.equal(parseMaxOut('max_tokens must be between 1 and 8192'), 8192);
  assert.equal(parseMaxOut('maximum output length is 65536 tokens'), 65536);
  assert.equal(parseMaxOut('something went wrong'), null);
  assert.equal(parseMaxOut(undefined), null);
});

await t('parseCtx 取原文里最大的合理整数,不会把错误码当成上限', () => {
  assert.equal(parseCtx('Prompt exceeds max length 1048576'), 1048576);
  // [1261] 是错误码。不设下界的话它会被当成「这个模型只吃 1261 token」——
  // 面板显示 [1K],而真值是 1M
  assert.equal(parseCtx('[1261] Prompt exceeds max length'), null);
  assert.equal(parseCtx('limit is 999999999999'), null, '离谱的大数不采信');
  assert.equal(parseCtx(''), null);
});

await t('parseCtx 优先认原文点名的上限,而不是盲取最大值', () => {
  // ling-3.0-flash-fin-free 的实测原文(2026-08-29)。这里 limit 在前、我请求的量
  // 在后,盲取最大值会读成 1500001 —— 那是**我发出去的量**,不是上限。而这个数会
  // 以 method=validator 落盘,且 run 只探没记录的,所以再也不会重探:面板从此
  // 显示 [1M],真值其实是 256K。
  assert.equal(parseCtx("This endpoint's maximum context length is 262144 tokens. "
    + 'However, you requested about 1500001 tokens (1500000 of text input, 1 in the output).'), 262144);
  // 反过来的写法(请求量在前、limit 在后)也得读出 limit。两种格式方向相反,
  // 所以单靠取最值必然错一边 —— 这正是要按句式认的原因
  assert.equal(parseCtx('[1261] input 1300000 tokens > limit 1048576'), 1048576);
  // 点名的上限允许小于 100000。那个下界是给「盲取最大值」防错误码用的,句式既然
  // 点了名就没有这个歧义;沿用下界的话 64K 级模型永远读不出上限
  assert.equal(parseCtx('maximum context length is 65536 tokens'), 65536);
  assert.equal(parseCtx('限制上下文长度[1,262144]'), 262144);
  // 点名但离谱的数照样不采信,退回盲取那条路(它也拒),最终 null
  assert.equal(parseCtx('limit is 999999999999'), null);
  // 「rate limit」里也有个 limit,但它说的是每天多少次请求,不是上下文上限。
  // 按裸 \blimit\b 认会把配额读成上下文 —— 现实里 parseCtx 只在超限探测的
  // terminal 4xx 上被调用(429 走的是限流分支,压根到不了这儿),但原文里带一句
  // rate limit 的 400 是存在的,不该因此记下一个假上限
  assert.equal(parseCtx('rate limit: 1000000 requests per day exceeded'), null);
  assert.equal(parseCtx('Rate limit exceeded, retry after 3600 seconds'), null);
  // 收紧之后真上限仍然要读得出来 —— 同一句话里两种 limit 都在时以上下文那个为准
  assert.equal(parseCtx('rate limit ok; input 1300000 tokens > limit 1048576'), 1048576);
});

// ── SEED 和记录 ─────────────────────────────────────────

await t('SEED 每条都完整,顶档在六档之内', () => {
  for (const [id, r] of Object.entries(SEED)) {
    // ctx 允许是 null(muse-spark 那种探过了但探不出上限的),但只要不是 null
    // 就得是个正整数 —— 少个后缀不致命,一个假上限会让人照着它截长文。
    // ctx 是 null 的那几条必须带 ctxAt,否则每个全新容器都要为它白探一次
    if (r.ctx == null) assert.ok(r.ctxAt > 0, `${id} 的 ctx 是空的就得有 ctxAt,不然会被反复重探`);
    else assert.ok(Number.isInteger(r.ctx) && r.ctx > 0, `${id} 的 ctx 写了就得是正整数`);
    // top 反过来必须有:折错档会让请求直接失败,这条没有兜底的余地
    assert.ok(LADDER.includes(r.top), `${id} 的顶档 ${r.top} 不在六档里`);
    if (r.efforts !== null) {
      assert.ok(Array.isArray(r.efforts) && r.efforts.length, `${id} 的 efforts 要么是非空数组要么是 null`);
      for (const lv of r.efforts) assert.ok(LADDER.includes(lv), `${id} 的 ${lv} 不是档位`);
      // 顶档得是它认的那几档里最强的,否则夹取会给出一个它压根不认的档位
      assert.equal(r.top, r.efforts[r.efforts.length - 1], `${id} 的顶档和 efforts 对不上`);
    }
  }
});

await t('effortMapOf 缺字段时兜底成 high + 宽松(也就是有记录之前的老行为)', () => {
  const m = effortMapOf({ a: {}, b: { top: 'max', efforts: [] }, c: { efforts: ['low'] }, d: null });
  assert.deepEqual(m.a, { top: 'high', efforts: null });
  assert.deepEqual(m.b, { top: 'max', efforts: null }, '空数组当没有,不然 clampEffort 会夹到 undefined');
  assert.deepEqual(m.c, { top: 'high', efforts: ['low'] });
  assert.ok(!('d' in m), '坏条目直接跳过');
  assert.deepEqual(Object.keys(effortMapOf(null)), [], '没有记录时给空表而不是抛');
});

await t('load:盘上那份盖过 SEED,读坏了退回只用 SEED', () => {
  const file = tmpFile('caps-load.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    models: { 'hy3-free': { ctx: 999, top: 'max', efforts: null }, 'new-free': { ctx: 4096, top: 'low' } },
  }));
  const caps = new Capabilities({ file, post: async () => ({}) });
  assert.equal(caps.get('hy3-free').ctx, 999, '同一个 id 撞车时信盘上探出来的那份');
  assert.equal(caps.get('new-free').ctx, 4096);
  assert.equal(caps.get('big-pickle').ctx, SEED['big-pickle'].ctx, 'SEED 垫在下面,没被盖的照旧');

  const bad = tmpFile('caps-bad.json');
  fs.writeFileSync(bad, '{ 不是 json');
  const warns = [];
  const caps2 = new Capabilities({ file: bad, post: async () => ({}), logger: (lv, m) => warns.push(lv) });
  assert.equal(caps2.get('big-pickle').ctx, SEED['big-pickle'].ctx, '读坏了也得能起来 —— 记录是缓存不是账本');
  assert.ok(warns.includes('warn'), '但要说一声');
});

await t('ctxMap 只给点名的那些,查不到的不编造', () => {
  const caps = new Capabilities({ file: tmpFile('caps-ctx.json'), post: async () => ({}) });
  const m = caps.ctxMap(['big-pickle', 'brand-new-free']);
  assert.deepEqual(Object.keys(m), ['big-pickle'], '没记录的模型不出现在表里(前端据此不显示后缀)');
  // 不点名时给全部 —— 下线的模型也在里面,所以面板必须传清单进来
  assert.ok(Object.keys(caps.ctxMap()).length > Object.keys(m).length);
});

// ── 探测编排 ────────────────────────────────────────────

/** 假 post:按请求内容决定回什么。返回 {calls} 便于断言真的发了几次 */
function fakePost(handler) {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    const r = handler(body, calls.length);
    if (r?.throw) throw r.throw;
    return r ?? { choices: [], usage: {} };
  };
  return { post, calls };
}

await t('探档位:严格模型从 400 原文里读出它认的那几档,不再多问一次顶档', async () => {
  const { post, calls } = fakePost((b) => {
    if (b.reasoning_effort === '__probe__') {
      return { throw: { status: 400, body: '[1210] please use low, high, or max' } };
    }
    if (b.max_tokens === 900_000_000) {
      return { throw: { status: 400, body: '限制数值范围[1,131072]' } };
    }
    return {};
  });
  const caps = new Capabilities({ file: tmpFile('caps-e1.json'), post });
  const r = await caps.probeEfforts('strict-free');
  assert.deepEqual(r.efforts, ['low', 'high', 'max']);
  assert.equal(r.top, 'max', '顶档就是它认的最强那档');
  assert.equal(r.maxOut, 131072);
  assert.equal(calls.length, 2, '原文已经点名了档位,不用再拿 max 试一次');
});

await t('探档位:宽松模型(非法档位也 200)要单独问一次顶档', async () => {
  const { post, calls } = fakePost((b) => {
    // 认不出的档位直接丢掉照常回答,max 也照收
    if (b.max_tokens === 900_000_000) return { throw: { status: 400, body: 'no limit info here' } };
    return {};
  });
  const caps = new Capabilities({ file: tmpFile('caps-e2.json'), post });
  const r = await caps.probeEfforts('lenient-free');
  assert.equal(r.efforts, null, '不报错 = 不用夹');
  assert.equal(r.top, 'max');
  assert.equal(r.maxOut, null, '原文里没有数字就不记,别硬猜一个');
  assert.ok(calls.some((c) => c.reasoning_effort === 'max'), '得真的拿 max 试过');
});

await t('探档位:max 打不通的宽松模型顶档落到 high', async () => {
  const { post } = fakePost((b) => (b.reasoning_effort === 'max'
    ? { throw: { status: 400, body: 'unsupported' } }
    : {}));
  const caps = new Capabilities({ file: tmpFile('caps-e3.json'), post });
  const r = await caps.probeEfforts('picky-free');
  assert.equal(r.top, 'high');
});

await t('探档位撞 429 直接抛,不把限流当成「探到了」', async () => {
  const { post } = fakePost(() => ({ throw: { status: 429, body: 'rate limited' } }));
  const caps = new Capabilities({ file: tmpFile('caps-e4.json'), post });
  await assert.rejects(() => caps.probeEfforts('x-free'), (e) => e.status === 429);
});

await t('模型不可用不是能力信息,探测应保留错误而不是缓存假档位', async () => {
  const { post } = fakePost(() => ({ throw: {
    status: 400,
    body: '{"error":{"message":"Model is unavailable"}}',
  } }));
  const caps = new Capabilities({ file: tmpFile('caps-model-unavailable.json'), post });
  await assert.rejects(() => caps.probeEfforts('gone-free'), (e) => e.status === 400);
  assert.equal(caps.get('gone-free'), null, '模型不可用不能落能力记录');
});

await t('鉴权错误不是能力信息,不能把 401 缓存成模型档位', async () => {
  const { post } = fakePost(() => ({ throw: { status: 401, body: 'Unauthorized' } }));
  const caps = new Capabilities({ file: tmpFile('caps-auth-error.json'), post });
  await assert.rejects(() => caps.probeEfforts('auth-free'), (e) => e.status === 401);
  assert.equal(caps.get('auth-free'), null);
});

await t('探上下文:校验器报了数就直接采信,一次出站', async () => {
  const { post, calls } = fakePost(() => ({ throw: { status: 400, body: 'Prompt exceeds max length 262144' } }));
  const caps = new Capabilities({ file: tmpFile('caps-c1.json'), post });
  const r = await caps.probeContext('v-free');
  assert.equal(r.ctx, 262144);
  assert.equal(r.method, 'validator');
  assert.equal(calls.length, 1, '报了数就不用夹');
});

await t('探上下文:原文没数字时在候选表里夹,夹出来的是能过的最大那个', async () => {
  const LIMIT = 1_048_576;
  const { post, calls } = fakePost((b) => {
    const n = b.messages[0].content.length / 5;    // filler 是 'word ' 重复,5 字符一个 token
    return n > LIMIT ? { throw: { status: 400, body: '[1261] Prompt exceeds max length' } } : {};
  });
  const caps = new Capabilities({ file: tmpFile('caps-c2.json'), post });
  const r = await caps.probeContext('b-free');
  assert.equal(r.ctx, 1048576);
  assert.equal(r.method, 'bracket');
  // 二分,不是逐个试:5 个候选最多 3 次,加上顶探那次
  assert.ok(calls.length <= 1 + Math.ceil(Math.log2(CTX_CANDIDATES.length)) + 1, `试了 ${calls.length} 次,太多了`);
});

await t('探上下文:截断型模型在顶探里露馅 —— prompt_tokens 就是上限', async () => {
  const { post } = fakePost(() => ({ usage: { prompt_tokens: 196608 } }));
  const caps = new Capabilities({ file: tmpFile('caps-c3.json'), post });
  const r = await caps.probeContext('t-free');
  assert.equal(r.ctx, 196608);
  assert.equal(r.method, 'truncate', '它不报错,超出的那截被静默丢掉');
});

await t('探上下文:比顶探还大的模型记 null,不写个假数进去', async () => {
  const { post } = fakePost((b) => ({ usage: { prompt_tokens: b.messages[0].content.length / 5 } }));
  const caps = new Capabilities({ file: tmpFile('caps-c4.json'), post });
  const r = await caps.probeContext('huge-free');
  assert.equal(r.ctx, null);
  assert.equal(r.method, 'over-probe');
});

await t('探上下文:流量预算不够就直接不探,而不是探一半', async () => {
  const { post, calls } = fakePost(() => ({}));
  const caps = new Capabilities({ file: tmpFile('caps-c5.json'), post });
  const r = await caps.probeContext('big-free', 1024);
  assert.equal(r.method, 'skipped-budget');
  assert.equal(calls.length, 0, '一个字节都没出站');
});

await t('run:只探缺的那些,全都有记录时一个字节都不出站', async () => {
  const { post, calls } = fakePost(() => ({}));
  const caps = new Capabilities({ file: tmpFile('caps-r1.json'), post });
  const r = await caps.probeMissing(Object.keys(SEED));
  assert.equal(r.note, 'nothing-missing');
  assert.equal(calls.length, 0, '正常重启该是免费的');
});

await t('run:新模型探完落盘,再 new 一个就直接读到(下线又上线也复用这条)', async () => {
  const file = tmpFile('caps-r2.json');
  const { post } = fakePost((b) => {
    if (b.reasoning_effort === '__probe__') return { throw: { status: 400, body: 'please use low or high' } };
    if (b.max_tokens === 900_000_000) return { throw: { status: 400, body: '限制数值范围[1,65536]' } };
    return { throw: { status: 400, body: 'Prompt exceeds max length 262144' } };
  });
  const caps = new Capabilities({ file, post });
  caps.stamp = () => 1_700_000_000_000;      // 时间戳不该让测试变成不确定的
  const r = await caps.probeMissing(['brand-new-free']);
  assert.equal(r.skipped.length, 0, JSON.stringify(r));
  assert.equal(caps.get('brand-new-free').ctx, 262144);
  assert.deepEqual(caps.get('brand-new-free').efforts, ['low', 'high']);
  assert.equal(caps.get('brand-new-free').top, 'high');
  assert.equal(caps.get('brand-new-free').maxOut, 65536);

  const again = new Capabilities({ file, post: async () => { throw new Error('不该再出站'); } });
  assert.equal(again.get('brand-new-free').ctx, 262144, '记录留在盘上,下次直接复用');
  assert.deepEqual(again.effortMap()['brand-new-free'], { top: 'high', efforts: ['low', 'high'] });
});

await t('run:max_tokens 那一探失败不该连坐 —— efforts/top 已经探到了就得留下', async () => {
  // muse-spark-1.2-contributor-free 的真实行为(2026-08-21):什么都回怪状态码,
  // 而 max_tokens=9e8 偏偏回 429。以前这一下会把整轮掐掉,于是它每次开机都白探
  const file = tmpFile('caps-r6.json');
  const { post } = fakePost((b) => {
    if (b.max_tokens === 900_000_000) return { throw: { status: 429, body: '{"id":"chatcmpl_x"}' } };
    return { throw: { status: 400, body: '{"id":"chatcmpl_x"}' } };   // 正文里连 error 都没有
  });
  const caps = new Capabilities({ file, post });
  caps.stamp = () => 1;
  const r = await caps.probeMissing(['weird-free'], { context: false });
  assert.equal(r.note, 'ok', `不该按限流停手: ${JSON.stringify(r)}`);
  assert.equal(caps.get('weird-free').top, 'high', '顶档探到了(它把 max 也 400 了)就得记下来');
  assert.equal(caps.get('weird-free').efforts, null, '原文里没有档位词 = 按宽松处理');
  assert.equal(caps.get('weird-free').maxOut, null, '这个值只是留档,探不到就空着');
});

await t('run:「探过但没探出数字」也算探过,不会每次开机再花一次 6MB', async () => {
  const file = tmpFile('caps-r7.json');
  // 顶探就过了(prompt_tokens 对得上)→ over-probe:上限比顶探还大,记不了准数
  const { post, calls } = fakePost((b) => ({ usage: { prompt_tokens: b.messages[0].content.length / 5 } }));
  const caps = new Capabilities({ file, post });
  caps.stamp = () => 1;
  const first = await caps.probeMissing(['huge-free']);
  assert.ok(first.skipped.some((x) => x.includes('over-probe')), JSON.stringify(first));
  assert.equal(caps.get('huge-free').ctx, null, 'ctx 留 null,面板就不显示后缀');
  assert.equal(caps.get('huge-free').ctxAt, 1, '但要留个戳,证明问过了');
  assert.deepEqual(caps.ctxMap(['huge-free']), {}, 'null 不该冒充上限跑到面板上');

  const spent = calls.length;
  const again = new Capabilities({ file, post });
  assert.equal((await again.probeMissing(['huge-free'])).note, 'nothing-missing');
  assert.equal(calls.length, spent, '第二次一个字节都不该再花');
});

await t('run:流量预算不够那次不留戳,下次该接着探', async () => {
  const file = tmpFile('caps-r8.json');
  const { post } = fakePost((b) => (b.reasoning_effort || b.max_tokens === 900_000_000
    ? {}
    : { throw: { status: 400, body: 'Prompt exceeds max length 262144' } }));
  const caps = new Capabilities({ file, post });
  caps.stamp = () => 1;
  // 预算耗尽要攒够 8 个模型才撞得到,这里直接钉 run() 的记录规则:
  // 上下文那一探报 skipped-budget 时落不落戳
  caps.probeContext = async () => ({ ctx: null, method: 'skipped-budget', spent: 0 });
  const r = await caps.probeMissing(['later-free']);
  assert.ok(r.skipped.some((x) => x.includes('skipped-budget')), JSON.stringify(r));
  assert.equal(caps.get('later-free').ctxAt, undefined, '「这轮没轮到」不是结论,不能留戳');
  assert.equal(caps.get('later-free').top, 'max', '档位那半照样探到了');
});

await t('run:撞 429 就停下,已经探到的先落盘,并且说清楚哪些没探', async () => {
  const file = tmpFile('caps-r3.json');
  const { post } = fakePost((b) => (b.model === 'a-free'
    ? {}
    : { throw: { status: 429, body: 'slow down' } }));
  const logs = [];
  const caps = new Capabilities({ file, post, logger: (lv, m) => logs.push(`${lv} ${m}`) });
  caps.stamp = () => 1;
  const r = await caps.probeMissing(['a-free', 'b-free'], { context: false });
  assert.equal(r.note, 'rate-limited');
  assert.ok(r.probed.some((s) => s.startsWith('a-free')), '探到的要报出来');
  assert.ok(r.skipped.some((s) => s.includes('b-free') && s.includes('限流')), '没探到的更要报出来');
  assert.ok(logs.some((l) => l.startsWith('warn')), '悄悄少探会让人以为表是全的');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).models['a-free'], '半路停下也别把探到的丢了');
});

await t('run:并发调用共用同一轮,面板按钮点两下不出两轮站', async () => {
  let running = 0, peak = 0;
  const post = async () => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return {};
  };
  const caps = new Capabilities({ file: tmpFile('caps-r4.json'), post });
  const [a, b] = await Promise.all([
    caps.probeMissing(['p-free'], { context: false }),
    caps.probeMissing(['p-free'], { context: false }),
  ]);
  assert.equal(a, b, '第二次拿到的是同一个 Promise 的结果');
  assert.equal(peak, 1, '探测是串行的:几 MB 的并发上传只会互相拖慢,还更容易撞限流');
});

await t('run:探测失败不落进记录,下次开机还会再探一遍', async () => {
  const file = tmpFile('caps-r5.json');
  const { post } = fakePost(() => ({ throw: { status: 0, body: 'ECONNREFUSED' } }));
  const caps = new Capabilities({ file, post });
  const r = await caps.probeMissing(['down-free'], { context: false });
  assert.equal(r.probed.length, 0);
  // 网络不通时 probeEfforts 会把「400 但读不出档位」当成宽松,那是**错的记录**,
  // 比没有记录更糟 —— 所以 status 0 这条路不能写进 records
  assert.equal(caps.get('down-free'), null, '连不上不等于探到了「宽松」');
});

console.log(`\ncapabilities.mjs: 全部通过 (${n} 组)\n`);
fs.rmSync(TMP, { recursive: true, force: true });
