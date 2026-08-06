/**
 * verify-api.mjs —— 拿一个真在跑的网关验两种方言的端到端行为。
 *
 * 和另外两个脚本的分工:
 *   verify-tunnel.mjs    CONNECT 协议本身(自签证书,不需要网络)
 *   verify-upstream.mjs  出站是否真经代理(比对出口 IP)
 *   本脚本                客户端视角:两种方言、两种鉴权、流式事件顺序
 *
 * 存在的理由:实测那次 /v1/messages 全线 401(只认 Bearer 不认 x-api-key),
 * 而客户端把 401 显示成「模型不存在」。单测能挡形状,挡不住「部署上去到底通不通」。
 *
 * 用法:
 *   BASE=http://ds4f.example.com KEY=zen-xxxx node scripts/verify-api.mjs
 *
 * 不给 BASE 就跳过并退 0 —— CI 里没有活网关,不该因此变红。
 */

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const KEY = process.env.KEY || '';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 90_000);

if (!BASE || !KEY) {
  console.log('verify-api: 跳过 —— 需要 BASE 和 KEY 环境变量');
  process.exit(0);
}

let failed = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => { failed++; console.log(`  FAIL ${m}`); };
const note = (m) => console.log(`  ..  ${m}`);

const withTimeout = (ms) => AbortSignal.timeout(ms);

console.log(`verify-api: ${BASE}\n`);

// ── 1. 活着没 ────────────────────────────────────────────
try {
  const r = await fetch(`${BASE}/health`, { signal: withTimeout(20_000) });
  const j = await r.json();
  if (r.status === 200 && j.ok) ok(`/health 通,model=${j.fixedModel || j.model}${j.paused ? ' (paused)' : ''}`);
  else bad(`/health 异常: ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
} catch (e) {
  bad(`/health 连不上: ${e.message} —— 后面的检查无意义`);
  process.exit(1);
}

// ── 2. 鉴权:两种头都要认,错的都要挡 ─────────────────────
for (const [label, headers] of [
  ['Bearer(OpenAI 客户端)', { authorization: `Bearer ${KEY}` }],
  ['x-api-key(Anthropic 客户端)', { 'x-api-key': KEY }],
]) {
  try {
    const r = await fetch(`${BASE}/v1/models`, { headers, signal: withTimeout(20_000) });
    await r.text();
    if (r.status === 200) ok(`${label} 能过`);
    else bad(`${label} 被拒(${r.status})—— 这类客户端会把它显示成「模型不存在」`);
  } catch (e) { bad(`${label} 请求失败: ${e.message}`); }
}

try {
  const r = await fetch(`${BASE}/v1/models`, { headers: { 'x-api-key': 'definitely-wrong' }, signal: withTimeout(20_000) });
  await r.text();
  if (r.status === 401) ok('错的 key 被挡下');
  else bad(`错的 key 竟然返回 ${r.status} —— 鉴权形同虚设`);
} catch (e) { bad(`错 key 检查失败: ${e.message}`); }

// ── 3. OpenAI 非流式 ─────────────────────────────────────
try {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: '只回复数字 2' }] }),
    signal: withTimeout(TIMEOUT),
  });
  const dt = Date.now() - t0;
  const j = await r.json();
  if (r.status === 200 && j.choices?.[0]?.message) {
    ok(`chat/completions 200(${dt}ms)tokens=${j.usage?.total_tokens ?? '?'}`);
  } else if (r.status === 429) {
    note(`chat/completions 429(${dt}ms)—— 所有出口都在冷却,链路本身是通的`);
  } else {
    bad(`chat/completions ${r.status}(${dt}ms): ${JSON.stringify(j).slice(0, 200)}`);
  }
} catch (e) { bad(`chat/completions 失败: ${e.message}`); }

// ── 4. Anthropic 非流式 ──────────────────────────────────
try {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', max_tokens: 64, messages: [{ role: 'user', content: '只回复数字 2' }] }),
    signal: withTimeout(TIMEOUT),
  });
  const dt = Date.now() - t0;
  const j = await r.json();
  if (r.status === 200) {
    // 形状要对得上 SDK 的期待,不然客户端会当成畸形响应
    const shapeOk = j.type === 'message' && j.role === 'assistant'
      && Array.isArray(j.content) && j.content.length > 0
      && typeof j.usage?.input_tokens === 'number';
    if (shapeOk) ok(`messages 200(${dt}ms)content[0].type=${j.content[0].type} stop=${j.stop_reason}`);
    else bad(`messages 200 但形状不对: ${JSON.stringify(j).slice(0, 200)}`);
  } else if (r.status === 429) {
    note(`messages 429(${dt}ms)—— 出口冷却中`);
  } else {
    bad(`messages ${r.status}(${dt}ms): ${JSON.stringify(j).slice(0, 200)}`);
  }
} catch (e) { bad(`messages 失败: ${e.message}`); }

// ── 5. Anthropic 流式:事件顺序必须合法 ───────────────────
// SDK 是状态机解析,顺序错了它直接抛,而不是"少显示一点内容"
try {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '数到 3' }] }),
    signal: withTimeout(TIMEOUT),
  });

  if (r.status !== 200) {
    const b = await r.text();
    if (r.status === 429) note(`流式 429 —— 出口冷却中`);
    else bad(`流式 ${r.status}: ${b.slice(0, 200)}`);
  } else {
    const events = [];
    let text = '';
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('event: ')) events.push(line.slice(7).trim());
        else if (line.startsWith('data: ')) {
          try {
            const j = JSON.parse(line.slice(6));
            if (j.delta?.type === 'text_delta') text += j.delta.text;
          } catch {}
        }
      }
    }

    if (events[0] === 'message_start') ok('流式:message_start 打头');
    else bad(`流式:首个事件是 ${events[0]},SDK 会直接抛`);

    if (events.at(-1) === 'message_stop') ok('流式:message_stop 收尾');
    else bad(`流式:末个事件是 ${events.at(-1)},客户端会挂到超时`);

    // start/stop 必须配对,否则客户端一直等那个块
    let open = 0, unbalanced = false;
    for (const e of events) {
      if (e === 'content_block_start') open++;
      if (e === 'content_block_stop') { open--; if (open < 0) unbalanced = true; }
    }
    if (open === 0 && !unbalanced) ok('流式:content_block start/stop 全部配对');
    else bad(`流式:块没配平(剩 ${open} 个没关)`);

    if (text.trim()) ok(`流式:收到文本 ${JSON.stringify(text.slice(0, 40))}`);
    else bad('流式:一个字都没收到');
  }
} catch (e) { bad(`流式失败: ${e.message}`); }

// ── 6. count_tokens ──────────────────────────────────────
try {
  const r = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello world' }] }),
    signal: withTimeout(20_000),
  });
  const j = await r.json();
  if (r.status === 200 && Number.isInteger(j.input_tokens) && j.input_tokens > 0) {
    ok(`count_tokens 给出 ${j.input_tokens}(Claude Code 开工前会问这个)`);
  } else {
    bad(`count_tokens ${r.status}: ${JSON.stringify(j).slice(0, 120)}`);
  }
} catch (e) { bad(`count_tokens 失败: ${e.message}`); }

console.log(failed === 0 ? '\nverify-api: 全部通过' : `\nverify-api: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
