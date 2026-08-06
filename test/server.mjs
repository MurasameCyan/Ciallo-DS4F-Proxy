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

const { NodeCooldown, UsageTracker, Gateway, COOLDOWN_MS, FREE_MODELS, pickFreeModels } = await import('../server/gateway.mjs');
const { buildMihomoYaml, load, genApiKey } = await import('../server/config.mjs');
const { parseBasic, safeEqual, resolveCredentials, matches, readCookie, Sessions, FailWindow } = await import('../server/auth.mjs');
const { connectTunnel } = await import('../server/proxy.mjs');
const { shortSha, buildId, buildInfo, checkUpdate } = await import('../server/build.mjs');
const { createApp } = await import('../server/index.mjs');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// ── 冷却状态机 ──────────────────────────────────────────

const NODES = ['A', 'B', 'C'];

await t('429 的节点进冷却,pickAvailable 跳过它', () => {
  const c = new NodeCooldown();
  c.mark429('A');
  assert.equal(c.isCooling('A'), true);
  assert.equal(c.pickAvailable(NODES), 'B');
  assert.equal(c.pickAvailable(NODES, new Set(['B'])), 'C');
});

await t('冷却过期后自动放行,不用等谁来清', () => {
  const c = new NodeCooldown();
  c.cooldowns.set('A', Date.now() - COOLDOWN_MS - 1);
  assert.equal(c.isCooling('A'), false);
  assert.equal(c.cooldowns.has('A'), false, '过期项应就地删掉,否则 summary 会一直带着它');
  assert.equal(c.pickAvailable(NODES), 'A');
});

await t('全员冷却时 soonest 给出剩余最短的那个', () => {
  const c = new NodeCooldown();
  c.cooldowns.set('A', Date.now() - 10_000);   // 剩 80s
  c.cooldowns.set('B', Date.now() - 80_000);   // 剩 10s
  c.cooldowns.set('C', Date.now() - 40_000);
  assert.equal(c.pickAvailable(NODES), null);
  assert.equal(c.soonest(NODES).node, 'B');
  assert.equal(c.soonest([]), null, '没节点时不能返回半个对象');
});

await t('summary 的 remain 是秒,且不含已过期项', () => {
  const c = new NodeCooldown();
  c.mark429('A');
  c.cooldowns.set('B', Date.now() - COOLDOWN_MS - 1);
  const s = c.summary();
  assert.equal(s.length, 1);
  assert.equal(s[0].node, 'A');
  assert.ok(s[0].remain > 85 && s[0].remain <= 90, `remain 应是秒级 90 左右,得到 ${s[0].remain}`);
});

await t('clearAll 返回清掉的个数(面板要显示)', () => {
  const c = new NodeCooldown();
  c.mark429('A'); c.mark429('B');
  assert.equal(c.clearAll(), 2);
  assert.equal(c.cooldowns.size, 0);
});

// ── 用量统计 ────────────────────────────────────────────

await t('用量三个维度一起涨,reasoning 从嵌套字段取', () => {
  const f = path.join(TMP, 'u1.json');
  const u = new UsageTracker(f, () => {});
  u.record('m1', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } }, true);
  u.record('m1', null, false);
  const d = u.getStats();
  assert.equal(d.total.requests, 2);
  assert.equal(d.total.success, 1);
  assert.equal(d.total.fail, 1);
  assert.equal(d.total.reasoningTokens, 3);
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
  assert.deepEqual(await g.refreshModels(), ['a-free', 'big-pickle']);
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
    await g.refreshModels();
    assert.deepEqual(g.freeModels(), FREE_MODELS, '前端已经没有本地常量兜底了,这里空了面板就空');
  }
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

// ── 把真 server 拉起来打一遍 ────────────────────────────

const cfg = load();
const creds = { user: 'tester', pass: 'test-pass', generated: false };
const gateway = new Gateway(cfg, () => {});
// 别让测试真的出站去拉模型清单:/api/status 每次都会顺手起一次刷新,
// 有没有内核、能不能连上游都不该影响断言
gateway.upstreamGet = async () => { throw new Error('测试不出站'); };
const app = createApp({ cfg, creds, gateway });
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
  assert.equal(j.model, 'deepseek-v4-flash-free');
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
  assert.deepEqual(Object.keys(j).sort(), ['apiKey', 'port', 'subscriptionUrl'], '字段形状是前端契约,不能改');

  const s = await (await fetch(`${base}/api/status`, { headers: { authorization: auth } })).json();
  assert.equal(s.fixedModel, 'deepseek-v4-flash-free');
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
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.type, 'no_nodes');
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

await t('保存非法订阅地址被挡下', async () => {
  const r = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ subscriptionUrl: 'ftp://nope' }),
  });
  assert.equal(r.status, 400);
  await r.text();
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
    body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
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
    body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [] }),
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
