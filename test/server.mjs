/**
 * server.mjs —— 后端自检。
 *
 * 本机没有 Docker,镜像跑不起来,所以这里尽量把"不靠容器就能验的"都验掉:
 * 冷却状态机、mihomo 配置生成、Basic 鉴权、CONNECT 隧道、以及把真 server
 * 拉到临时端口上打一遍路由和鉴权。
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
delete process.env.SUBSCRIPTION_URL;
delete process.env.API_KEY;

const { NodeCooldown, UsageTracker, Gateway, COOLDOWN_MS } = await import('../server/gateway.mjs');
const { buildMihomoYaml, load, genApiKey } = await import('../server/config.mjs');
const { parseBasic, safeEqual, resolveCredentials } = await import('../server/auth.mjs');
const { connectTunnel } = await import('../server/proxy.mjs');
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

// ── 节点测速与排序 ──────────────────────────────────────

/** 造一个不需要内核的 Gateway:mihomoApi 换成假的 */
function fakeGateway(delays) {
  const g = new Gateway(load(), () => {});
  const names = Object.keys(delays);
  g.mihomoApi = async (p) => {
    const m = decodeURIComponent(p).match(/^\/proxies\/(.+?)\/delay/);
    if (!m) return { all: names, now: names[0] };
    const d = delays[m[1]];
    if (d == null) throw new Error('HTTP 503');   // mihomo 对不通的节点回非 2xx
    return { delay: d };
  };
  return g;
}

await t('测速:不通的记 null,通的记毫秒', async () => {
  const g = fakeGateway({ A: 300, B: null, C: 80 });
  const r = await g.testNodes();
  assert.equal(r.tested, 3);
  assert.equal(r.alive, 2);
  assert.deepEqual(r.dead, ['B']);
  assert.deepEqual(r.fastest, { node: 'C', delay: 80 });
  assert.deepEqual(g.delayMap(), { A: 300, B: null, C: 80 });
  assert.ok(g.testedAt > 0);
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

await t('全灭时不剔除 —— 测速地址不可达不等于节点不可用', async () => {
  const g = fakeGateway({ A: null, B: null });
  const r = await g.testNodes();
  assert.equal(r.alive, 0);
  assert.deepEqual(g.rankNodes(['A', 'B']), ['A', 'B'], '全剔掉等于把整个网关关掉');
  assert.deepEqual(g.excludedNodes(['A', 'B']), []);
});

await t('测速之后才出现的节点保留在表尾,不当成死的', async () => {
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

await t('并发测速只跑一遍', async () => {
  let calls = 0;
  const g = fakeGateway({ A: 100, B: 200 });
  const inner = g.mihomoApi;
  g.mihomoApi = (...a) => { calls++; return inner(...a); };
  const [r1, r2] = await Promise.all([g.testNodes(), g.testNodes()]);
  assert.equal(r1, r2, '第二个调用应搭车,不是再测一轮');
  assert.equal(calls, 3, '1 次取节点 + 2 次测延迟');
  assert.equal(g.testing, null, '测完要把占位清掉,否则下次点测速直接返回旧结果');
});

await t('一个节点都没有时测速不抛', async () => {
  const g = new Gateway(load(), () => {});
  g.mihomoApi = async () => ({ all: [] });
  const r = await g.testNodes();
  assert.equal(r.tested, 0);
  assert.equal(r.fastest, null);
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

// ── 把真 server 拉起来打一遍 ────────────────────────────

const cfg = load();
const creds = { user: 'tester', pass: 'test-pass', generated: false };
const gateway = new Gateway(cfg, () => {});
const app = createApp({ cfg, creds, gateway });
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;
const auth = 'Basic ' + Buffer.from('tester:test-pass').toString('base64');

await t('/health 不要凭据(docker healthcheck 得进得来)', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.model, 'deepseek-v4-flash-free');
});

await t('面板和 /api/* 匿名访问一律 401', async () => {
  for (const p of ['/', '/index.html', '/api/config', '/api/status', '/api/nodes', '/api/logs']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 401, `${p} 应该 401 而不是 ${r.status} —— 这里会明文吐订阅凭据`);
    assert.match(r.headers.get('www-authenticate') || '', /^Basic/, '得给 challenge,浏览器才会弹框');
    await r.text();
  }
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
  const r = await fetch(`${base}/../package.json`, { headers: { authorization: auth } });
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

await t('POST /api/nodes/test 触发测速并回摘要', async () => {
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
