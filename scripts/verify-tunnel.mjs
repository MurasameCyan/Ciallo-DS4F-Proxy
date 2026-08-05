#!/usr/bin/env node
/**
 * verify-tunnel.mjs —— 验 MihomoAgent 整条出站链路。
 *
 * 这是本项目最关键的一条回归测试。原 desktop-app 用 `new https.Agent({proxy})`
 * 出站,而 https.Agent 没有 proxy 这个选项 —— 请求全程直连,mihomo 被绕过,
 * 换节点换了也白换。整个项目的立论功能是空转的。详见 server/proxy.mjs。
 *
 * 这里用一个真的 CONNECT 代理 + 一台假 opencode.ai 把链路跑通,断言:
 *   1. 真的发了 CONNECT,请求行正确
 *   2. TLS 跑在隧道之上,SNI 带对了(不带上游会返回错证书)
 *   3. 证书校验没被悄悄关掉
 *   4. keepAlive 关着 —— 复用旧隧道等于还挂在旧节点的出口 IP 上
 *   5. 请求形态是 zen 免费端点认的那个:无 Authorization + User-Agent: node
 *
 * 不在 test/server.mjs 里是因为要一张自签证书,而 Node 没法不靠 openssl 生成。
 * 那边测到协议层为止(发没发 CONNECT、被拒时报没报错)。
 *
 *   node scripts/verify-tunnel.mjs        # 需要 PATH 上有 openssl
 */

import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MihomoAgent } from '../server/proxy.mjs';

const HOST = 'opencode.ai';           // 假装的目标,证书 CN 也是它
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-tunnel-'));
const certFile = path.join(dir, 'cert.pem');
const keyFile = path.join(dir, 'key.pem');

const die = (msg) => { throw new Error(`✗ ${msg}`); };

try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile,
    '-days', '2', '-nodes', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`,
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('✗ 生成自签证书失败,PATH 上有 openssl 吗?\n' + (e.stderr?.toString() || e.message));
  process.exit(1);
}
const cert = fs.readFileSync(certFile);
const key = fs.readFileSync(keyFile);

// ── 假 opencode.ai:记下 SNI 和请求形态 ──
const sniSeen = [];
const upstream = https.createServer(
  { key, cert, SNICallback: (name, cb) => { sniSeen.push(name); cb(null, null); } },
  (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      path: req.url,
      ua: req.headers['user-agent'],
      hasAuth: !!req.headers.authorization,
    }));
  },
);
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

// ── 假 mihomo mixed-port:收 CONNECT 后把流量转给 upstream ──
// 真 mihomo 会按规则把它送去某个机场节点;这里送本地。对客户端没区别,
// 它只知道自己 CONNECT 了 opencode.ai:443。
const connectLines = [];
const proxy = net.createServer((client) => {
  client.once('readable', () => {
    const head = client.read();
    if (!head) return client.destroy();
    connectLines.push(head.toString().split('\r\n')[0]);
    const target = net.connect({ host: '127.0.0.1', port: upPort }, () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      client.pipe(target);
      target.pipe(client);
    });
    target.on('error', () => client.destroy());
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyPort = proxy.address().port;

const agent = new MihomoAgent(proxyPort);
const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

const hit = (opts = {}) => new Promise((resolve, reject) => {
  const r = https.request({
    host: HOST, port: 443, path: '/zen/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'node', 'Content-Length': Buffer.byteLength(body) },
    agent, ca: cert, timeout: 15_000, ...opts,
  }, (resp) => {
    let d = '';
    resp.on('data', (c) => (d += c));
    resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
  });
  r.on('error', reject);
  r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  r.end(body);
});

let failed = false;
try {
  const r1 = await hit();
  if (r1.status !== 200) die(`经隧道请求返回 ${r1.status}`);
  const j = JSON.parse(r1.body);
  console.log(`✓ 经隧道拿到响应 ${r1.status} ${r1.body}`);

  if (j.path !== '/zen/v1/chat/completions') die(`路径没带对: ${j.path}`);
  // zen 免费端点认的就是这个形态,补上 Bearer 反而 401
  if (j.ua !== 'node') die(`User-Agent 应为 node,得到 ${j.ua}`);
  if (j.hasAuth) die('不该带 Authorization');
  console.log('✓ 请求形态正确:无 Authorization + User-Agent: node');

  if (connectLines[0] !== `CONNECT ${HOST}:443 HTTP/1.1`) die(`CONNECT 请求行不对: ${connectLines[0]}`);
  console.log(`✓ ${connectLines[0]}`);

  if (sniSeen[0] !== HOST) die(`SNI 应为 ${HOST},得到 ${JSON.stringify(sniSeen)} —— 上游会握手失败或给错证书`);
  console.log(`✓ 服务端看到的 SNI: ${sniSeen[0]}`);

  await hit();
  await hit();
  if (connectLines.length !== 3) {
    die(`发了 3 个请求却只开了 ${connectLines.length} 条隧道 —— 复用旧隧道等于还在用旧节点的出口 IP`);
  }
  console.log(`✓ 3 个请求开了 3 条隧道(keepAlive 关着,换节点才有意义)`);

  // 不给 ca 就该拒:证明 rejectUnauthorized 没被关掉
  try {
    await hit({ agent: new MihomoAgent(proxyPort), ca: undefined });
    die('自签证书竟然通过了 —— rejectUnauthorized 被关了?');
  } catch (e) {
    if (!/SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(e.code || e.message)) throw e;
    console.log(`✓ 未信任的证书被拒: ${e.code || e.message}`);
  }

  console.log('\n✓ TLS-over-CONNECT 全部通过');
} catch (e) {
  failed = true;
  console.error(/^✗/.test(e.message) ? e.message : `✗ ${e.message}`);
} finally {
  agent.destroy();
  upstream.close();
  proxy.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(failed || process.exitCode ? 1 : 0);
