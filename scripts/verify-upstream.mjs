/**
 * verify-upstream.mjs —— 拿真上游验 proxy.mjs 那条出站链路。
 *
 * verify-tunnel.mjs 用自签证书验的是 CONNECT 协议本身(SNI、证书校验、不复用),
 * 那个不需要网络。这个脚本补的是它验不到的一件事:**请求真的从代理的 IP 出去了**,
 * 而不是静默直连。这正是 desktop-app 那个 bug 的形态 —— https.Agent 悄悄忽略
 * 未知的 proxy 选项,代码看着在用代理,包却走了本机。
 *
 * 判据是出口 IP 必须与直连不同。只看"请求成功"证明不了任何事:直连也会成功。
 *
 * 用法:
 *   PROXY_PORT=2080 node scripts/verify-upstream.mjs
 *
 * 需要一个在跑的 HTTP 代理(mihomo / clash / 任何 CONNECT 代理都行)。
 * 没有 PROXY_PORT 就跳过并退 0 —— CI 里没有代理,不该因此变红。
 */

import https from 'node:https';
import { MihomoAgent, connectTunnel } from '../server/proxy.mjs';

const PORT = Number(process.env.PROXY_PORT || 0);
const UPSTREAM_HOST = 'opencode.ai';
const CHAT_PATH = '/zen/v1/chat/completions';
const FIXED_MODEL = 'deepseek-v4-flash-free';

let failed = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => { failed++; console.log(`  FAIL ${m}`); };

/** 经指定 agent 发一个请求;agent 为 null 表示直连 */
function req({ host, path, agent, method = 'GET', body = null, timeout = 30_000 }) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'node', Accept: '*/*' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request({ host, port: 443, path, method, headers, agent, timeout }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
    });
    r.on('error', (e) => reject(e));
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end(body);
  });
}

if (!PORT) {
  console.log('verify-upstream: 跳过 —— 没给 PROXY_PORT(需要一个在跑的 HTTP 代理)');
  process.exit(0);
}

console.log(`verify-upstream: 经 127.0.0.1:${PORT} 打真上游\n`);

// ── 1. 隧道能不能建起来 ───────────────────────────────────
// 先单独验这一步,不然后面失败分不清是代理没起来还是上游拒了。
try {
  const sock = await connectTunnel({ proxyPort: PORT, host: UPSTREAM_HOST, port: 443 });
  ok(`CONNECT ${UPSTREAM_HOST}:443 建立成功`);
  sock.destroy();
} catch (e) {
  bad(`CONNECT 失败: ${e.message}`);
  console.log(`\n代理 127.0.0.1:${PORT} 不可用,后续检查无意义。`);
  process.exit(1);
}

// ── 2. 出口 IP 必须与直连不同 ─────────────────────────────
// 这条是整个脚本的核心。desktop-app 的 bug 里请求也"成功",
// 只是从本机 IP 出去的 —— 只有比对 IP 才能发现。
const agent = new MihomoAgent(PORT);
let proxyIp = null;
try {
  const r = await req({ host: 'api.ipify.org', path: '/', agent });
  proxyIp = r.body.trim();
  if (/^[\d.]+$/.test(proxyIp)) ok(`经代理出口 IP = ${proxyIp}`);
  else bad(`拿到的不像 IP: ${proxyIp.slice(0, 60)}`);
} catch (e) {
  bad(`经代理取出口 IP 失败: ${e.message}`);
}

let directIp = null;
try {
  const r = await req({ host: 'api.ipify.org', path: '/', agent: null, timeout: 15_000 });
  directIp = r.body.trim();
  console.log(`  ..  直连出口 IP = ${directIp}`);
} catch (e) {
  // 这台机器直连被限也是常见情况,不算失败 —— 下面会降级判断
  console.log(`  ..  直连取 IP 失败(${e.message}),改用"直连不通但代理通"作为判据`);
}

if (proxyIp && directIp) {
  if (proxyIp !== directIp) ok(`出口 IP 与直连不同 —— 请求真的走了代理`);
  else bad(`出口 IP 与直连相同(${proxyIp}) —— agent 被绕过了,这就是 desktop-app 那个 bug`);
} else if (proxyIp && !directIp) {
  ok(`直连取不到 IP 而经代理取到了 —— 请求真的走了代理`);
} else {
  bad('拿不到经代理的出口 IP,无法判断是否真走代理');
}

// ── 3. 真上游的响应 ───────────────────────────────────────
// 上游契约:不带 Authorization,User-Agent: node,模型必须是免费那批。
const payload = JSON.stringify({
  model: FIXED_MODEL,
  messages: [{ role: 'user', content: '只回复数字 2,不要其他内容' }],
  stream: false,
});
try {
  const t0 = Date.now();
  const r = await req({
    host: UPSTREAM_HOST, path: CHAT_PATH, agent,
    method: 'POST', body: payload, timeout: 60_000,
  });
  const dt = Date.now() - t0;

  if (r.status === 200) {
    const j = JSON.parse(r.body);
    const text = j.choices?.[0]?.message?.content ?? '';
    ok(`上游 200(${dt}ms) 回复=${JSON.stringify(text.slice(0, 40))} tokens=${j.usage?.total_tokens ?? '?'}`);
    if (j.usage) ok('响应带 usage —— 用量统计有数据可记');
    else bad('响应没有 usage,用量统计会一直是 0');
  } else if (r.status === 429) {
    // 不是失败:这正是轮换要处理的情况,说明这个出口的额度用完了
    console.log(`  ..  上游 429(${dt}ms) —— 这个出口额度已用尽,轮换机制正是为此存在`);
    ok('链路通(拿到了上游的真实业务响应,不是网络错误)');
  } else {
    bad(`上游 ${r.status}: ${r.body.slice(0, 200)}`);
  }
} catch (e) {
  bad(`打上游失败: ${e.message}`);
}

// ── 4. 每个请求必须开新隧道 ───────────────────────────────
// keepAlive 关掉的意义:复用旧隧道等于还挂在旧节点的出口 IP 上,换节点就白换了。
// 这里数的是 createConnection 被调用的次数。
{
  const counted = new MihomoAgent(PORT);
  let conns = 0;
  const orig = counted.createConnection.bind(counted);
  counted.createConnection = (o, cb) => { conns++; return orig(o, cb); };

  try {
    for (let i = 0; i < 3; i++) {
      await req({ host: 'api.ipify.org', path: '/', agent: counted });
    }
    if (conns === 3) ok(`3 个请求开了 3 条隧道 —— 没复用,换节点才是真的`);
    else bad(`3 个请求只开了 ${conns} 条隧道 —— 隧道被复用,换节点后仍走旧出口`);
  } catch (e) {
    bad(`隧道复用检查失败: ${e.message}`);
  }
}

console.log(failed === 0 ? '\nverify-upstream: 全部通过' : `\nverify-upstream: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
