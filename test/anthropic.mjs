/**
 * anthropic.mjs 自检 —— Messages API ⇄ OpenAI 互转。
 *
 * 这层全是纯函数,所以能把真实客户端会发的形状直接摆进来断言,不用起服务。
 * 重点测三类会让客户端"看起来是模型坏了"的错:
 *   1. 消息转换丢内容(并行 tool_result 被覆盖是参考实现的已知 bug)
 *   2. SSE 事件顺序非法(Anthropic SDK 按状态机解析,先 delta 后 start 直接抛)
 *   3. 块没配对关掉(客户端会一直等,最后超时,报的却是别的错)
 *
 * 跑:node test/anthropic.mjs
 */

import assert from 'node:assert/strict';
import {
  flattenText, toolsToOpenAI, toolChoiceToOpenAI, anthropicToOpenAI,
  openAIToAnthropic, anthropicError, errTypeFor, mapStop, AnthropicStream,
  reasoningEffort,
} from '../server/anthropic.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

/** 收集流事件,断言用 */
function collect(model = 'm') {
  const events = [];
  const st = new AnthropicStream({ model, emit: (event, data) => events.push({ event, data }) });
  return { st, events, names: () => events.map((e) => e.event) };
}
const feedJSON = (st, obj) => st.feed(`data: ${JSON.stringify(obj)}\n\n`);

// ── 请求转换 ────────────────────────────────────────────

t('system 从顶层字段变成第一条 system 消息', () => {
  const r = anthropicToOpenAI({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(r.messages[0], { role: 'system', content: 'be brief' });
  assert.deepEqual(r.messages[1], { role: 'user', content: 'hi' });
});

t('system 是 block 数组时拼成文本(Claude Code 就这么发)', () => {
  const r = anthropicToOpenAI({
    system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.messages[0].content, 'a\nb');
});

t('没有 system 时不插空消息', () => {
  const r = anthropicToOpenAI({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'user');
});

t('一条 user 消息里多个 tool_result 全部保留,不互相覆盖', () => {
  // 参考实现(Cline-proxy)在这里只留最后一个。并行调 3 个工具时前两个的
  // 结果凭空消失,模型对不上 id,表现为"它无视了工具输出"
  const r = anthropicToOpenAI({
    messages: [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
        { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
        { type: 'tool_result', tool_use_id: 'c', content: 'rc' },
      ],
    }],
  });
  const tools = r.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 3, '三个结果必须变成三条 role:tool');
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['a', 'b', 'c']);
  assert.deepEqual(tools.map((m) => m.content), ['ra', 'rb', 'rc']);
});

t('tool_result 的 content 是 block 数组时也能取到文本', () => {
  const r = anthropicToOpenAI({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'out' }] }] }],
  });
  assert.equal(r.messages[0].content, 'out');
});

t('assistant 的 tool_use 变成 tool_calls,arguments 是 JSON 字符串', () => {
  const r = anthropicToOpenAI({
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: '/a' } }] }],
  });
  const [m] = r.messages;
  assert.equal(m.role, 'assistant');
  assert.equal(m.tool_calls[0].function.name, 'read');
  assert.equal(typeof m.tool_calls[0].function.arguments, 'string', 'OpenAI 要字符串,给对象上游会 400');
  assert.deepEqual(JSON.parse(m.tool_calls[0].function.arguments), { path: '/a' });
});

t('多轮 assistant thinking 原样回传为 reasoning_content', () => {
  const r = anthropicToOpenAI({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先检查文件', signature: 'opaque-signature' },
        { type: 'tool_use', id: 't1', name: 'read', input: { path: '/a' } },
      ],
    }],
  });
  assert.equal(r.messages[0].reasoning_content, '先检查文件',
    'thinking 模式的后续轮次必须把原推理内容交还上游');
  assert.equal(r.messages[0].tool_calls[0].function.name, 'read');
});

t('工具结果和文字混在一条消息时,文字排在结果之后', () => {
  const r = anthropicToOpenAI({
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r' }, { type: 'text', text: '继续' }],
    }],
  });
  assert.deepEqual(r.messages.map((m) => m.role), ['tool', 'user']);
  assert.equal(r.messages[1].content, '继续');
});

t('image 块丢掉但不让整条消息失败', () => {
  const r = anthropicToOpenAI({
    messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: '这是什么' }] }],
  });
  assert.equal(r.messages[0].content, '这是什么');
});

t('采样参数按名字搬过去,top_k 刻意丢掉', () => {
  const r = anthropicToOpenAI({
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 100, temperature: 0.5, top_p: 0.9, top_k: 40, stop_sequences: ['END'],
  });
  assert.equal(r.max_tokens, 100);
  assert.equal(r.temperature, 0.5);
  assert.equal(r.top_p, 0.9);
  assert.deepEqual(r.stop, ['END']);
  assert.ok(!('top_k' in r), 'OpenAI 没这个字段,硬塞会让上游 400');
});

t('temperature 为 0 不能被当成缺省丢掉', () => {
  const r = anthropicToOpenAI({ messages: [{ role: 'user', content: 'x' }], temperature: 0 });
  assert.equal(r.temperature, 0, '0 是有意义的值(要确定性输出),不是"没传"');
});

t('工具定义:input_schema 挪到 function.parameters', () => {
  const out = toolsToOpenAI([{ name: 'grep', description: 'search', input_schema: { type: 'object' } }]);
  assert.deepEqual(out[0], { type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } });
  assert.equal(toolsToOpenAI([]), undefined, '空数组要给 undefined,不然会发个空 tools 上去');
  assert.equal(toolsToOpenAI(undefined), undefined);
});

t('tool_choice: any 对应 required', () => {
  assert.equal(toolChoiceToOpenAI({ type: 'any' }), 'required');
  assert.equal(toolChoiceToOpenAI({ type: 'auto' }), 'auto');
  assert.equal(toolChoiceToOpenAI({ type: 'none' }), 'none');
  assert.deepEqual(toolChoiceToOpenAI({ type: 'tool', name: 'x' }), { type: 'function', function: { name: 'x' } });
  assert.equal(toolChoiceToOpenAI(undefined), undefined);
});

// ── 响应转换(非流式)────────────────────────────────────

t('普通回复转成 content 数组 + usage 改名', () => {
  const r = openAIToAnthropic({
    model: 'm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.equal(r.type, 'message');
  assert.equal(r.role, 'assistant');
  assert.deepEqual(r.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(r.stop_reason, 'end_turn');
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
});

t('非流式响应报告客户端实际请求模型,不采用上游别名', () => {
  const r = openAIToAnthropic({
    model: 'provider-internal-alias',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  }, 'mimo-v2.5-free');
  assert.equal(r.model, 'mimo-v2.5-free');
});

t('非流式 reasoning_content 变成可在下轮回传的 thinking 块', () => {
  const r = openAIToAnthropic({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        reasoning_content: '先查配置',
        tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{"path":"/a"}' } }],
      },
    }],
  });
  assert.deepEqual(r.content[0], {
    type: 'thinking', thinking: '先查配置', signature: 'ciallo-zen-proxy',
  });
  assert.equal(r.content[1].type, 'tool_use');
});

t('tool_calls 转回 tool_use,arguments 字符串解析成对象', () => {
  const r = openAIToAnthropic({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{"path":"/a"}' } }] } }],
  });
  const block = r.content.find((c) => c.type === 'tool_use');
  assert.deepEqual(block.input, { path: '/a' }, 'Anthropic 这边 input 是对象');
  assert.equal(r.stop_reason, 'tool_use');
});

t('arguments 是坏 JSON 时给空对象而不是抛', () => {
  const r = openAIToAnthropic({ choices: [{ message: { tool_calls: [{ id: 't', function: { name: 'f', arguments: '{bad' } }] } }] });
  assert.deepEqual(r.content[0].input, {});
});

t('空回复也要有一个 content 块', () => {
  const r = openAIToAnthropic({ choices: [{ finish_reason: 'stop', message: { content: '' } }] });
  assert.equal(r.content.length, 1, 'content 是空数组的话 SDK 当畸形响应处理');
  assert.deepEqual(r.content[0], { type: 'text', text: '' });
});

t('finish_reason 映射', () => {
  assert.equal(mapStop('stop'), 'end_turn');
  assert.equal(mapStop('length'), 'max_tokens');
  assert.equal(mapStop('tool_calls'), 'tool_use');
  assert.equal(mapStop(undefined), 'end_turn', '认不出的一律 end_turn,别给 SDK 一个非法值');
});

t('错误体形状和 HTTP 状态映射', () => {
  assert.deepEqual(anthropicError('boom', 'rate_limit_error'), { type: 'error', error: { type: 'rate_limit_error', message: 'boom' } });
  assert.equal(errTypeFor(429), 'rate_limit_error');
  assert.equal(errTypeFor(401), 'authentication_error');
  assert.equal(errTypeFor(503), 'overloaded_error');
  assert.equal(errTypeFor(418), 'api_error', '没列出的状态要有兜底');
});

// ── SSE 流翻译 ──────────────────────────────────────────

t('纯文本流的事件顺序合法', () => {
  const { st, names } = collect();
  feedJSON(st, { choices: [{ delta: { content: 'he' } }] });
  feedJSON(st, { choices: [{ delta: { content: 'llo' } }] });
  feedJSON(st, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  st.end();
  assert.deepEqual(names(), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
});

t('message_start 只发一次', () => {
  const { st, names } = collect();
  feedJSON(st, { choices: [{ delta: { content: 'a' } }] });
  feedJSON(st, { choices: [{ delta: { content: 'b' } }] });
  st.end();
  assert.equal(names().filter((e) => e === 'message_start').length, 1);
});

t('文本按 text_delta 增量下发,拼起来是原文', () => {
  const { st, events } = collect();
  for (const s of ['你', '好', '世界']) feedJSON(st, { choices: [{ delta: { content: s } }] });
  st.end();
  const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, '你好世界');
});

t('半个 JSON 跨 chunk 到达时不丢内容', () => {
  const { st, events } = collect();
  const line = `data: ${JSON.stringify({ choices: [{ delta: { content: 'xyz' } }] })}\n\n`;
  st.feed(line.slice(0, 20));      // 断在中间
  st.feed(line.slice(20));
  st.end();
  const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'xyz', '缓冲区必须留住半行等下一块');
});

t('工具流:参数分片按 input_json_delta 累积,拼起来是完整 JSON', () => {
  const { st, events, names } = collect();
  feedJSON(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'read', arguments: '{"pa' } }] } }] });
  feedJSON(st, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a"}' } }] } }] });
  feedJSON(st, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  st.end();

  const start = events.find((e) => e.event === 'content_block_start');
  assert.equal(start.data.content_block.type, 'tool_use');
  assert.equal(start.data.content_block.name, 'read');

  const json = events.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), { path: '/a' }, '长参数必须完整,不能只取第一片');
  assert.equal(names().at(-3), 'content_block_stop', '块要在结束前关掉');
  assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

t('文本后接工具调用时,文本块先关再开工具块', () => {
  const { st, events } = collect();
  feedJSON(st, { choices: [{ delta: { content: '我来查一下' } }] });
  feedJSON(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'f', arguments: '{}' } }] } }] });
  st.end();
  const seq = events.map((e) => `${e.event}:${e.data.index ?? ''}`);
  const closeText = seq.indexOf('content_block_stop:0');
  const openTool = seq.indexOf('content_block_start:1');
  assert.ok(closeText >= 0 && openTool >= 0 && closeText < openTool,
    'Anthropic 不允许两个块同时开着,必须先关文本块');
});

t('多个并行工具各占一个 index,互不串块', () => {
  const { st, events } = collect();
  feedJSON(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f1', arguments: '{}' } }] } }] });
  feedJSON(st, { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'f2', arguments: '{}' } }] } }] });
  st.end();
  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((e) => e.data.index), [0, 1]);
  assert.deepEqual(starts.map((e) => e.data.content_block.id), ['a', 'b']);
  const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
  assert.deepEqual(stops.sort(), [0, 1], '两个块都得关');
});

t('一个 chunk 都没收到也给合法的空回复', () => {
  const { st, names } = collect();
  st.end();
  assert.deepEqual(names(), ['message_start', 'message_delta', 'message_stop'],
    '客户端等的是完整状态机,直接断开会让它挂到超时');
});

t('end 幂等,不会发两遍收尾', () => {
  const { st, names } = collect();
  feedJSON(st, { choices: [{ delta: { content: 'a' } }] });
  st.end();
  st.end();
  assert.equal(names().filter((e) => e === 'message_stop').length, 1);
});

t('中途失败也补齐收尾,并且块都关掉', () => {
  const { st, names, events } = collect();
  feedJSON(st, { choices: [{ delta: { content: 'partial' } }] });
  st.fail('upstream died');
  assert.ok(names().includes('error'));
  assert.equal(names().at(-1), 'message_stop', '报错后仍要正常收尾');
  assert.ok(names().includes('content_block_stop'), '已开的块必须关,否则客户端等到超时');
  assert.equal(events.find((e) => e.event === 'error').data.error.message, 'upstream died');
});

t('上游在流里塞错误帧时转成 error 事件并收尾', () => {
  const { st, names } = collect();
  feedJSON(st, { error: { message: 'rate limited' } });
  assert.ok(names().includes('error'));
  assert.equal(names().at(-1), 'message_stop');
});

t('[DONE] 和噪声行不会产生事件', () => {
  const { st, names } = collect();
  st.feed(': keep-alive\n\ndata: [DONE]\n\n');
  assert.deepEqual(names(), [], '收尾统一在 end() 做,[DONE] 不该自己触发');
});

t('坏 JSON 行跳过而不是让整条流崩掉', () => {
  const { st, events } = collect();
  st.feed('data: {not json\n\n');
  feedJSON(st, { choices: [{ delta: { content: 'ok' } }] });
  st.end();
  const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'ok');
});

t('usage 从上游帧里抄进 message_delta', () => {
  const { st, events } = collect();
  feedJSON(st, { choices: [{ delta: { content: 'a' } }], usage: { completion_tokens: 42 } });
  st.end();
  assert.equal(events.find((e) => e.event === 'message_delta').data.usage.output_tokens, 42);
});

// ── 推理内容 ────────────────────────────────────────────
//
// deepseek-v4-flash-free 这类模型会先吐几分钟 reasoning_content 再出正文
// (实测「写个 SVG 动画」的提问 200 秒内推理 68000 字、正文 0 字)。
// 这个字段以前被丢掉,于是客户端在 message_start 之后几分钟收不到任何事件,
// 看起来就是卡死/超时 —— 而上游其实一直在吐。

t('reasoning_content 变成 thinking 块', () => {
  const { st, events, names } = collect();
  feedJSON(st, { choices: [{ delta: { reasoning_content: '先想想' } }] });
  st.end();
  const start = events.find((e) => e.event === 'content_block_start');
  assert.equal(start.data.content_block.type, 'thinking');
  assert.equal(start.data.index, 0);
  const d = events.find((e) => e.data.delta?.type === 'thinking_delta');
  assert.equal(d.data.delta.thinking, '先想想');
  assert.ok(names().indexOf('content_block_start') < names().indexOf('content_block_delta'),
    '先 start 后 delta,反了 SDK 直接抛');
});

t('reasoning 这个字段名也认(不同上游叫法不一样)', () => {
  const { st, events } = collect();
  feedJSON(st, { choices: [{ delta: { reasoning: 'r' } }] });
  st.end();
  assert.equal(events.find((e) => e.data.delta?.type === 'thinking_delta').data.delta.thinking, 'r');
});

t('推理分片累积在同一个 thinking 块里,不是一片一块', () => {
  const { st, events } = collect();
  for (const s of ['一', '二', '三']) feedJSON(st, { choices: [{ delta: { reasoning_content: s } }] });
  st.end();
  assert.equal(events.filter((e) => e.event === 'content_block_start').length, 1);
  const text = events.filter((e) => e.data.delta?.type === 'thinking_delta').map((e) => e.data.delta.thinking).join('');
  assert.equal(text, '一二三');
});

t('正文开始时思考块先补 signature 再关掉', () => {
  const { st, events } = collect();
  feedJSON(st, { choices: [{ delta: { reasoning_content: '想' } }] });
  feedJSON(st, { choices: [{ delta: { content: '答' } }] });
  st.end();
  const seq = events.map((e) => `${e.event}:${e.data.index ?? ''}`);
  const sig = events.findIndex((e) => e.data.delta?.type === 'signature_delta');
  const stopThink = seq.indexOf('content_block_stop:0');
  const startText = seq.indexOf('content_block_start:1');
  assert.ok(sig >= 0, 'SDK 的 ThinkingBlock 要求 signature,缺了是非法块');
  assert.ok(sig < stopThink, 'signature_delta 必须在 stop 之前');
  assert.ok(stopThink < startText, '不能两个块同时开着');
  assert.equal(events.find((e) => e.event === 'content_block_start' && e.data.index === 1).data.content_block.type, 'text');
});

t('只有推理没有正文时也补 signature 并关块', () => {
  // 上游被掐断/到 max_tokens 就是这个形状:整段响应只有 thinking
  const { st, events, names } = collect();
  feedJSON(st, { choices: [{ delta: { reasoning_content: '想了很久' } }] });
  st.end();
  assert.ok(events.some((e) => e.data.delta?.type === 'signature_delta'));
  assert.deepEqual(names(), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
});

t('推理后直接调工具:思考块先关,工具块才开', () => {
  const { st, events } = collect();
  feedJSON(st, { choices: [{ delta: { reasoning_content: '要查文件' } }] });
  feedJSON(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'read', arguments: '{}' } }] } }] });
  st.end();
  const seq = events.map((e) => `${e.event}:${e.data.index ?? ''}`);
  assert.ok(seq.indexOf('content_block_stop:0') < seq.indexOf('content_block_start:1'));
  assert.equal(events.find((e) => e.data.index === 1 && e.event === 'content_block_start').data.content_block.type, 'tool_use');
});

t('thinking:false 时推理内容整段丢掉,不占块序号', () => {
  const events = [];
  const st = new AnthropicStream({ model: 'm', thinking: false, emit: (event, data) => events.push({ event, data }) });
  st.feed(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] })}\n\n`);
  st.feed(`data: ${JSON.stringify({ choices: [{ delta: { content: '答' } }] })}\n\n`);
  st.end();
  assert.equal(events.filter((e) => e.event === 'content_block_start').length, 1);
  assert.equal(events[1].data.index, 0, '正文块要占 index 0,不能给丢掉的思考块留号');
  assert.ok(!events.some((e) => e.data.delta?.type === 'thinking_delta'));
});

t('推理中途上游报错也能关掉思考块', () => {
  const { st, names } = collect();
  feedJSON(st, { choices: [{ delta: { reasoning_content: '想' } }] });
  st.fail('upstream died');
  assert.ok(names().includes('content_block_stop'), '开着的思考块必须关,否则客户端等到超时');
  assert.equal(names().at(-1), 'message_stop');
});

// ── 思考强度 ────────────────────────────────────────────

const DS4F = 'deepseek-v4-flash-free';
const NORTH = 'north-mini-code-free';

t('客户端显式给的档位直接采信,大小写和空格不影响', () => {
  assert.equal(reasoningEffort({ reasoning_effort: 'max' }, DS4F), 'max');
  assert.equal(reasoningEffort({ reasoning_effort: ' MAX ' }, DS4F), 'max');
  assert.equal(reasoningEffort({ reasoning: { effort: 'high' } }, DS4F), 'high');
});

t('xhigh 折到模型顶档 —— 原样发会被上游丢成默认,反而比 high 弱', () => {
  assert.equal(reasoningEffort({ reasoning_effort: 'xhigh' }, DS4F), 'max');
  // north-mini 的 thinkingLevelMap 里连 max 都是 null,顶档只到 high
  assert.equal(reasoningEffort({ reasoning_effort: 'xhigh' }, NORTH), 'high');
  assert.equal(reasoningEffort({ reasoning_effort: 'max' }, NORTH), 'high');
});

t('中低档原样放行,不因模型而变', () => {
  for (const lv of ['minimal', 'low', 'medium', 'high']) {
    assert.equal(reasoningEffort({ reasoning_effort: lv }, DS4F), lv);
    assert.equal(reasoningEffort({ reasoning_effort: lv }, NORTH), lv);
  }
});

t('不是档位的字符串当没给 —— 原样透传会让上游 400', () => {
  assert.equal(reasoningEffort({ reasoning_effort: 'foo' }, DS4F), '');
  assert.equal(reasoningEffort({ reasoning_effort: 9 }, DS4F), '');
  assert.equal(reasoningEffort({}, DS4F), '');
  assert.equal(reasoningEffort(null, DS4F), '');
});

t('Claude Code 的 budget_tokens 按关键词档位翻成 effort', () => {
  const budget = (n, m = DS4F) => reasoningEffort({ thinking: { type: 'enabled', budget_tokens: n } }, m);
  assert.equal(budget(1024), 'low');       // 协议下限
  assert.equal(budget(4000), 'medium');    // think
  assert.equal(budget(10000), 'high');     // think hard
  assert.equal(budget(31999), 'max');      // ultrathink —— 本次改动的目的
  // 顶档同样按模型收敛,不是无脑 max
  assert.equal(budget(31999, NORTH), 'high');
});

t('thinking 没开或 budget 非法时不发字段,交给上游默认', () => {
  assert.equal(reasoningEffort({ thinking: { type: 'disabled', budget_tokens: 31999 } }, DS4F), '');
  assert.equal(reasoningEffort({ thinking: { type: 'enabled' } }, DS4F), '');
  assert.equal(reasoningEffort({ thinking: { type: 'enabled', budget_tokens: 0 } }, DS4F), '');
});

t('output_config.effort 要认 —— 现在的 Claude Code 就发这个', () => {
  // 这条是回归测试:漏读这个字段时,客户端选「最多」在后台显示成空强度,
  // 看起来像"透传没生效",实际是四种写法里唯一在用的那种没被读
  const oc = (effort, m = DS4F) => reasoningEffort({ output_config: { effort } }, m);
  assert.equal(oc('max'), 'max');
  assert.equal(oc('xhigh'), 'max', 'xhigh 是 Claude Code 的默认档,不能被丢掉');
  assert.equal(oc('medium'), 'medium');
  assert.equal(oc('xhigh', NORTH), 'high');
  assert.equal(oc('max', NORTH), 'high');
  assert.equal(oc('foo'), '', '乱值仍然当没给');
});

t('thinking.adaptive 不等于关掉思考', () => {
  // 新模型上 budget_tokens 已弃用,CC 发的是 adaptive + output_config.effort
  assert.equal(reasoningEffort({
    thinking: { type: 'adaptive' }, output_config: { effort: 'max' },
  }, DS4F), 'max');
  // adaptive 自己不带强度,那就随上游默认 —— 但如果还捎了 budget 就得读出来
  assert.equal(reasoningEffort({ thinking: { type: 'adaptive' } }, DS4F), '');
  assert.equal(reasoningEffort({ thinking: { type: 'adaptive', budget_tokens: 31999 } }, DS4F), 'max');
});

t('三种显式写法的优先级:reasoning_effort > reasoning.effort > output_config.effort', () => {
  assert.equal(reasoningEffort({
    reasoning_effort: 'low', reasoning: { effort: 'medium' }, output_config: { effort: 'max' },
  }, DS4F), 'low');
  assert.equal(reasoningEffort({
    reasoning: { effort: 'medium' }, output_config: { effort: 'max' },
  }, DS4F), 'medium');
});

t('anthropicToOpenAI 带上 output_config 的档位,但不把 output_config 本身发给上游', () => {
  const out = anthropicToOpenAI({
    model: DS4F,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
  });
  assert.equal(out.reasoning_effort, 'max');
  assert.ok(!('output_config' in out), 'OpenAI 那边不认这个字段');
  assert.ok(!('thinking' in out));
});

t('显式档位优先于 budget —— 两个都给时不能被翻译覆盖', () => {
  assert.equal(reasoningEffort({
    reasoning_effort: 'low', thinking: { type: 'enabled', budget_tokens: 31999 },
  }, DS4F), 'low');
});

t('anthropicToOpenAI 把 ultrathink 带成 reasoning_effort', () => {
  const out = anthropicToOpenAI({
    model: DS4F,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 31999 },
  });
  assert.equal(out.reasoning_effort, 'max');
  // 没给思考参数时不能凭空多一个字段
  assert.ok(!('reasoning_effort' in anthropicToOpenAI({
    model: DS4F, messages: [{ role: 'user', content: 'hi' }],
  })));
});

// ── flattenText 边界 ────────────────────────────────────

t('flattenText 各种输入都不抛', () => {
  assert.equal(flattenText('x'), 'x');
  assert.equal(flattenText([{ type: 'text', text: 'a' }, { type: 'image' }]), 'a');
  assert.equal(flattenText(null), '');
  assert.equal(flattenText(undefined), '');
  assert.equal(flattenText(123), '');
});

console.log(`\nanthropic.mjs: 全部通过 (${n} 组)\n`);
