/**
 * e2e.mjs —— 端到端冒烟:把真 server 拉起来,用假上游走完整条链路。
 *
 * 和另外两个测试文件的分工:
 *   check.mjs      前端纯函数
 *   anthropic.mjs  转换层纯函数(形状对不对)
 *   server.mjs     路由和鉴权(进得去出得来)
 *   本文件          装起来会不会动 —— 尤其是流式:sink 接线、事件顺序、
 *                  usage 有没有一路带到底。这些只有真跑 HTTP 才暴露得出来。
 *
 * 上游和 mihomo 都用假的,所以不需要网络、不消耗额度,能进 CI。
 *
 * 跑:node test/e2e.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-e2e-'));
process.env.DATA_DIR = TMP;
process.env.PANEL_PASS = 'p';
delete process.env.SUBSCRIPTION_URL;
delete process.env.API_KEY;

// 假 mihomo 控制端口:报一个节点,PUT 一律成功。
// 端口写死成 config.mjs 里的 CTRL_PORT,gateway 才连得上。
const { CTRL_PORT } = await import('../server/config.mjs');
const ctrl = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'PUT') return void res.end('{}');
  if (req.url.startsWith('/proxies/')) return void res.end(JSON.stringify({ all: ['N1'], now: 'N1' }));
  res.end('{}');
});
await new Promise((r) => ctrl.listen(CTRL_PORT, '127.0.0.1', r));

const { Gateway, FREE_MODELS } = await import('../server/gateway.mjs');
// 每个请求都得带一个真在免费清单里的模型 —— 网关现在严格校验,
// 不在清单里的当场 400 而不出站(见 server.mjs 的「严格模型透传」那几组)
const MODEL = FREE_MODELS[0];
const { createApp } = await import('../server/index.mjs');
const cfgMod = await import('../server/config.mjs');

const cfg = cfgMod.load();
cfg.apiKey = 'k';
const gw = new Gateway(cfg, () => {});

/** 假上游:一段带 usage 的流,和一个普通回复 */
const STREAM_CHUNKS = [
  { choices: [{ delta: { role: 'assistant', content: '' } }] },
  { choices: [{ delta: { content: '你好' } }] },
  { choices: [{ delta: { content: '世界' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
];
// 只替掉真正出网的两个方法,轮换/冷却/方言分发全部走真代码
let sent = null;                 // 最后一次真发给上游的 body,用来断言透传结果
gw.forward = async (body) => {
  sent = body;
  return {
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '2' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
};
gw.forwardStream = async (res, body, dialect) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  const sink = dialect.sink(res, body.model);
  for (const c of STREAM_CHUNKS) sink.write(`data: ${JSON.stringify(c)}\n\n`);
  sink.write('data: [DONE]\n\n');
  sink.end();
  return { ok: true, usage: STREAM_CHUNKS.at(-1).usage };
};

const app = createApp({ cfg, creds: { user: 'a', pass: 'p' }, gateway: gw });
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;

let bad = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const no = (m) => { bad++; console.log(`  FAIL ${m}`); };

// ── OpenAI 非流式 ───────────────────────────────────────
{
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  j.choices?.[0]?.message?.content === '2'
    ? ok('OpenAI 非流式原样透传')
    : no(`OpenAI 非流式: ${JSON.stringify(j).slice(0, 150)}`);
}

// ── Anthropic 非流式 ────────────────────────────────────
{
  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  const good = j.type === 'message' && j.content?.[0]?.text === '2' && j.usage?.input_tokens === 3;
  good ? ok('Anthropic 非流式转成 Messages 形状') : no(`Anthropic 非流式: ${JSON.stringify(j).slice(0, 150)}`);
}

// ── OpenAI 流式必须原样,不能被翻译 ──────────────────────
{
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await r.text();
  body.includes('data: {') && body.includes('[DONE]') && !body.includes('event: ')
    ? ok('OpenAI 流式原样透传(没被 Anthropic 那套改写)')
    : no(`OpenAI 流式被改写: ${body.slice(0, 150)}`);
}

// ── 思考强度真的出站了吗(回归「客户端选 max,后台强度是空的」)──
// 前面几组只证明纯函数算得对,这组证明算出来的档位确实进了发给上游的 body。
// 现在的 Claude Code 把强度放在 output_config.effort,不是 thinking.budget_tokens。
{
  // 这几组断言的是「顶档折成 max」,所以模型必须写死成唯一支持 max 的那个
  // (见 anthropic.mjs 的 MAX_CAPABLE),不能跟着 FREE_MODELS[0] 走 ——
  // 那份常量按字母排序过一次,第一个就从 ds4f 变成了 big-pickle,
  // 而 big-pickle 的顶档是 high,三组断言集体报假故障。
  const MAX_MODEL = 'deepseek-v4-flash-free';
  const ask = async (extra) => {
    sent = null;
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MAX_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra }),
    });
    return sent;
  };

  const cc = await ask({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } });
  cc?.reasoning_effort === 'max'
    ? ok('Anthropic:output_config.effort=max 出站成 reasoning_effort=max')
    : no(`output_config.effort 没出站:reasoning_effort=${JSON.stringify(cc?.reasoning_effort)}`);
  !('output_config' in (cc ?? {})) && !('thinking' in (cc ?? {}))
    ? ok('Anthropic:output_config / thinking 不往上游发')
    : no('OpenAI 不认的字段漏出去了');

  const xh = await ask({ output_config: { effort: 'xhigh' } });
  xh?.reasoning_effort === 'max'
    ? ok('Anthropic:xhigh 折到模型顶档(原样发会被上游丢成默认)')
    : no(`xhigh 没折档:${JSON.stringify(xh?.reasoning_effort)}`);

  const ut = await ask({ thinking: { type: 'enabled', budget_tokens: 31999 } });
  ut?.reasoning_effort === 'max'
    ? ok('Anthropic:旧写法 ultrathink 仍然出站成顶档')
    : no(`budget_tokens 回归了:${JSON.stringify(ut?.reasoning_effort)}`);

  const none = await ask({});
  !('reasoning_effort' in (none ?? {}))
    ? ok('Anthropic:没说强度时不发这个字段,随上游默认')
    : no(`凭空多了 reasoning_effort=${JSON.stringify(none?.reasoning_effort)}`);
}

// ── Anthropic 流式:事件顺序 + 内容完整性 ────────────────
{
  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await r.text();
  const events = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1].trim());
  const text = [...body.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join('');

  events[0] === 'message_start' ? ok('流式:message_start 打头') : no(`流式首事件是 ${events[0]}`);
  body.includes(`\"model\":\"${MODEL}\"`)
    ? ok('流式:message_start 报告客户端实际请求模型')
    : no(`流式 message_start 没报告客户端模型 ${MODEL}`);
  events.at(-1) === 'message_stop' ? ok('流式:message_stop 收尾') : no(`流式末事件是 ${events.at(-1)}`);

  const opens = events.filter((e) => e === 'content_block_start').length;
  const stops = events.filter((e) => e === 'content_block_stop').length;
  opens === stops && opens > 0
    ? ok(`流式:${opens} 个 content_block 全部配对`)
    : no(`流式块没配平:${opens} 开 / ${stops} 关`);

  text === '你好世界' ? ok(`流式:文本完整「${text}」`) : no(`流式文本对不上:「${text}」`);
  body.includes('"output_tokens":2') ? ok('流式:usage 一路带到 message_delta') : no('流式 usage 丢了');
}

// ── Anthropic 流式:推理内容(回归「十分钟没动静」)──────
// deepseek-v4-flash-free 在出正文之前会先吐几分钟 reasoning_content。
// 这个字段以前被丢掉,客户端于是在 message_start 之后长时间收不到任何事件,
// 表现成卡死/超时 —— 而上游一直在吐。这里让假上游只发推理,验它变成
// 合法的 thinking 块并带上 signature。
{
  const saved = gw.forwardStream;
  gw.forwardStream = async (res, body, dialect) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const sink = dialect.sink(res, body.model);
    for (const s of ['让我', '想想']) {
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: s } }] })}\n\n`);
    }
    sink.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '答案' } }], usage: { completion_tokens: 7 } })}\n\n`);
    sink.write('data: [DONE]\n\n');
    sink.end();
    return { ok: true, usage: { completion_tokens: 7 } };
  };

  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await r.text();
  const events = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1].trim());
  const think = [...body.matchAll(/"thinking_delta","thinking":"([^"]*)"/g)].map((m) => m[1]).join('');
  const text = [...body.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join('');

  think === '让我想想' ? ok('流式:推理内容变成 thinking 块') : no(`推理内容对不上:「${think}」`);
  body.includes('"thinking":""') ? ok('流式:thinking 块的 start 形状合法') : no('thinking 块没有合法的 content_block_start');
  body.includes('signature_delta') ? ok('流式:thinking 块补了 signature') : no('thinking 块缺 signature,SDK 会当非法块');
  text === '答案' ? ok('流式:推理之后正文照常') : no(`正文对不上:「${text}」`);

  const opens = events.filter((e) => e === 'content_block_start').length;
  const stops = events.filter((e) => e === 'content_block_stop').length;
  opens === 2 && stops === 2
    ? ok('流式:thinking 和 text 各占一块且都关掉')
    : no(`推理流块数不对:${opens} 开 / ${stops} 关`);

  gw.forwardStream = saved;
}

// ── 断连不该让进程崩 ────────────────────────────────────
// sink 的 write 全都包了 try/catch,这里验它真的兜住了
{
  const ac = new AbortController();
  const p = fetch(`${base}/v1/messages`, {
    method: 'POST', signal: ac.signal,
    headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  }).catch(() => null);
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 50));
  const alive = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
  alive ? ok('客户端中途断开后服务仍然健康') : no('客户端断开把服务搞挂了');
}

// ── 流开始后失败,绝不能重试 ────────────────────────────
// 头都发出去了还换节点重发,等于把两半响应拼给客户端。
// 这里让上游在吐了一半之后炸掉,数 forwardStream 被调了几次。
{
  let calls = 0;
  gw.forwardStream = async (res, body, dialect) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const sink = dialect.sink(res, body.model);
    sink.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半句' } }] })}\n\n`);
    // 模拟 forwardStream 内部「started 之后出错」的收尾路径
    sink.fail('upstream died mid-stream');
    return { ok: false, usage: null };
  };

  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await r.text();
  const events = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1].trim());

  calls === 1 ? ok('流中途失败没有重试(否则客户端会收到两半响应)') : no(`重试了,forwardStream 被调 ${calls} 次`);
  events.includes('error') ? ok('中途失败发了 error 事件') : no('中途失败没告诉客户端');
  events.at(-1) === 'message_stop'
    ? ok('中途失败仍补上合法收尾,客户端不会挂到超时')
    : no(`中途失败末事件是 ${events.at(-1)}`);
}

// ── Responses:非流式透传 + 字符串 input 补数组 + 嵌套 reasoning.effort ──
// 上游原生支持 Responses(见 gateway 的 RESPONSES 方言),所以这条是「近乎透传」。
{
  const savedFwd = gw.forward;
  let rsent = null;
  gw.forward = async (body) => {
    rsent = body;
    return {
      object: 'response', model: 'm',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '2' }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    };
  };

  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
  });
  const j = await r.json();
  j.object === 'response' && j.output?.[0]?.content?.[0]?.text === '2'
    ? ok('Responses 非流式原样透传(不翻译成 chat)')
    : no(`Responses 非流式: ${JSON.stringify(j).slice(0, 150)}`);

  // 字符串 input:上游只认数组(纯字符串 → 400 Empty input messages),网关补上
  rsent = null;
  await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: 'hi', reasoning: { effort: 'medium' } }),
  }).then((x) => x.text());
  Array.isArray(rsent?.input) && rsent.input[0]?.content?.[0]?.text === 'hi'
    ? ok('Responses:字符串 input 补成上游要的数组')
    : no(`字符串 input 没补成数组:${JSON.stringify(rsent?.input)}`);
  rsent?.reasoning?.effort === 'medium' && !('reasoning_effort' in (rsent ?? {}))
    ? ok('Responses:思考强度进 reasoning.effort,不注入顶层 reasoning_effort')
    : no(`reasoning 没进对地方:嵌套=${JSON.stringify(rsent?.reasoning)} 顶层=${JSON.stringify(rsent?.reasoning_effort)}`);

  gw.forward = savedFwd;
}

// ── Responses 流式:response.* 原样透传,收尾漏出的 chat 杂块吞掉 ──
{
  const saved = gw.forwardStream;
  gw.forwardStream = async (res, body, dialect) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const sink = dialect.sink(res, body.model);
    sink.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你好' })}\n\n`);
    sink.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '世界' })}\n\n`);
    sink.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`);
    // 漏块型模型(deepseek/hy3)收尾漏出的原始 chat 块,严格 Responses 客户端会解析报错
    sink.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
    sink.write('data: [DONE]\n\n');
    sink.end();
    return { ok: true, usage: { input_tokens: 3, output_tokens: 2 } };
  };

  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
  });
  const body = await r.text();
  const text = [...body.matchAll(/"delta":"([^"]*)"/g)].map((m) => m[1]).join('');

  text === '你好世界' ? ok('Responses 流式:正文事件完整透传') : no(`Responses 流式文本对不上:「${text}」`);
  body.includes('response.completed') ? ok('Responses 流式:completed 事件透传') : no('Responses 流式 completed 丢了');
  !body.includes('chat.completion.chunk') ? ok('Responses 流式:收尾漏出的 chat 杂块被吞掉') : no('chat 杂块漏给了严格客户端');
  !body.includes('event: ') ? ok('Responses 流式:裸 data: 帧,没被 Anthropic 那套改写') : no('Responses 流式混进了 event: 行');
  body.includes('[DONE]') ? ok('Responses 流式:[DONE] 原样透传') : no('Responses 流式 [DONE] 丢了');

  gw.forwardStream = saved;
}

await new Promise((r) => app.close(r));
await new Promise((r) => ctrl.close(r));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(bad === 0 ? '\ne2e.mjs: 全部通过\n' : `\ne2e.mjs: ${bad} 项失败\n`);
process.exit(bad ? 1 : 0);
