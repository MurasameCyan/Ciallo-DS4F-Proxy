/**
 * anthropic.mjs —— Anthropic Messages API ⇄ OpenAI Chat Completions 互转。
 *
 * 为什么要这一层:上游 zen 只有 /chat/completions 一种形状,而 Claude Code、
 * Cline 这类客户端说的是 Messages API —— POST /v1/messages、x-api-key 鉴权、
 * SSE 用 `event:` 命名事件而不是裸 `data:`。所以入口开两个,出口只有一个:
 *
 *   /v1/chat/completions ──┐
 *                          ├─→ 同一套节点轮换/重试 ─→ opencode zen
 *   /v1/messages ──转换────┘
 *
 * 这个文件只有纯函数和一个流翻译器,不碰网络,能直接 assert。
 *
 * 参考了 https://github.com/YuJunZhiXue/Cline-proxy 的 proxy.go,但避开它两处:
 *   1. 一条 user 消息里多个 tool_result 只转出最后一个(前面的被覆盖)
 *   2. 工具参数刚收到第一个分片就 emit content_block_start+stop,长参数会截断
 * 这里 tool_use 按规范走 input_json_delta 增量,块在流结束时才关。
 */

/** Anthropic 的 content 可以是 string 也可以是 block 数组,统一抽成纯文本 */
export function flattenText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') { parts.push(b); continue; }
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** 工具定义:Anthropic 的 input_schema 挪到 OpenAI 的 function.parameters */
export function toolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    // 有些客户端会直接塞 OpenAI 形状过来,那就别动它
    if (t.type === 'function' && t.function) { out.push(t); continue; }
    if (!t.name) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

/**
 * 思考强度的合法档位。客户端能说的全集,不代表每个模型都认。
 * 挡掉明显不是档位的字符串,免得把乱输入原样送出去换一个 400。
 */
export const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 客户端表达「顶档」的两种说法。它们要落到模型实际认的最高档,而不是原样发出去 */
const TOP = new Set(['xhigh', 'max']);

/**
 * 认 max 这一档的模型。
 *
 * 这张表必须存在,因为 zen 对不认的档位是**丢字段**而不是降到最近一档:
 * DS4F 的 thinkingLevelMap 里 off/minimal/low/medium/xhigh 全是 null,只有
 * high/max 有值 —— 客户端选「极高(xhigh)」原样发过去会被丢掉、回落到默认 high,
 * 于是「极高」比「最多」还弱。而 north-mini-code-free 反过来:它只到 high,
 * 连 max 都是 null,所以也不能无脑把顶档都发成 max。
 *
 * ponytail: 上限是这张表得手工维护,而 zen 的免费清单换得挺勤。不在表里的模型
 * 按 high 处理 —— 那是各家最普遍支持的顶档,宁可少一档也不会被丢成默认值。
 * 哪天某个免费模型也支持 max 了,往这儿加一行就行。
 */
const MAX_CAPABLE = new Set(['deepseek-v4-flash-free']);

/** 这个模型实际认的最高档 */
const topEffort = (model) => (MAX_CAPABLE.has(String(model ?? '').trim()) ? 'max' : 'high');

/**
 * thinking.budget_tokens → 档位。
 *
 * Anthropic 协议里没有 reasoning_effort,老客户端表达思考强度只有 budget_tokens
 * 这一个旋钮(新写法见 reasoningEffort 的 output_config.effort),而 Claude Code
 * 把它绑在关键词上:think≈4000、think hard≈10000、ultrathink=31999(协议下限
 * 1024)。所以「想更用力」这件事客户端已经说清楚了,只是说的是另一种语言 ——
 * 翻过来就不用再加开关。
 *
 * 边界取在这几个关键词之间,而不是均分区间:ultrathink 要落到顶档,
 * think hard 落到 high(DS4F 的默认档),这样用户敲的词和拿到的强度是对得上的。
 *
 * 表里只列到 high,顶档交给 topEffort(model) 定 —— budget_tokens 这种写法
 * 本身不区分 xhigh 和 max,能表达的最强就是「顶」。
 */
const BUDGET_TIERS = [
  [2_048, 'low'],
  [8_000, 'medium'],
  [16_000, 'high'],
];

/**
 * 从客户端请求里读出思考强度,读不到就返回 ''(调用方据此不发这个字段,
 * 随上游自己的默认 —— DS4F 是 high)。
 *
 * 四种写法都认,按优先级:
 *   reasoning_effort         OpenAI 顶层
 *   reasoning.effort         Responses 风格
 *   output_config.effort     Anthropic 现行写法 ← 现在的 Claude Code 走这条
 *   thinking.budget_tokens   Anthropic 旧写法
 *
 * output_config.effort 这一条是必需的,不是补全:budget_tokens 在新模型上已经
 * 被 Anthropic 弃用(部分模型直接 400),客户端选「最多」发出来的是
 * output_config:{effort:'max'} 加 thinking:{type:'adaptive'} —— 而 adaptive
 * 不等于 enabled,于是旧实现在这儿两条都读不到、返回 ''、面板强度栏是空的。
 * 现象就是「客户端选了 max,到后台强度直接没显示」。
 *
 * 前三种是客户端明说的,但「顶档」这件事客户端只知道自己在说 xhigh 或 max,
 * 不知道这个模型的顶到底叫什么 —— 所以 xhigh/max 统一折到 topEffort(model),
 * 其余档位原样放行(不认就被上游丢,那是上游自己的事,至少不会比它说的更强或更弱)。
 * budget_tokens 那种写法本身就不区分 xhigh/max,翻译时直接给顶档。
 */
export function reasoningEffort(req, model = '') {
  const raw = req?.reasoning_effort ?? req?.reasoning?.effort ?? req?.output_config?.effort;
  const want = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (EFFORTS.has(want)) return TOP.has(want) ? topEffort(model) : want;

  // 明确关掉思考时不发字段:DS4F 关不掉思考,硬塞个最低档也是被上游丢掉,
  // 不如让它走默认 —— 至少行为是可预期的。
  // adaptive 一并放行到下面:它自己不带强度(「你自己决定用多少」),但客户端
  // 有可能 adaptive 和 budget_tokens 一起发,那个 budget 还是该读出来。
  const type = req?.thinking?.type;
  if (type !== 'enabled' && type !== 'adaptive') return '';
  const budget = Number(req?.thinking?.budget_tokens);
  if (!Number.isFinite(budget) || budget <= 0) return '';
  const tier = BUDGET_TIERS.find(([max]) => budget <= max)?.[1];
  return tier ?? topEffort(model);
}

/** {type:'any'} 是「必须调工具但随便哪个」,对上 OpenAI 的 'required' */
export function toolChoiceToOpenAI(tc) {
  if (!tc || typeof tc !== 'object') return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

/**
 * 请求:Anthropic → OpenAI。
 *
 * 三处形状差异是这个函数的全部工作量:
 *   system   顶层独立字段  → messages 里 role:'system' 的第一条
 *   tool_use assistant 的内容块 → assistant.tool_calls[](arguments 是字符串!)
 *   tool_result user 的内容块  → 独立的 role:'tool' 消息,一个 result 一条
 */
export function anthropicToOpenAI(req) {
  const msgs = [];

  const sys = flattenText(req.system);
  if (sys) msgs.push({ role: 'system', content: sys });

  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';

    if (typeof m.content === 'string') {
      msgs.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    const texts = [];
    const reasoning = [];
    const toolCalls = [];
    const toolResults = [];
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      switch (b.type) {
        case 'text':
          if (typeof b.text === 'string') texts.push(b.text);
          break;
        case 'thinking':
          if (role === 'assistant' && typeof b.thinking === 'string') reasoning.push(b.thinking);
          break;
        case 'tool_use':
          toolCalls.push({
            id: String(b.id ?? ''),
            type: 'function',
            function: {
              name: String(b.name ?? ''),
              // OpenAI 这里要的是 JSON 字符串,不是对象
              arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
            },
          });
          break;
        case 'tool_result':
          // 每个 result 都得单独成一条 role:'tool' —— 一轮里并行调了 N 个工具就有
          // N 个 result 挤在同一条 user 消息里,合并或覆盖会让模型对不上 id
          toolResults.push({
            role: 'tool',
            tool_call_id: String(b.tool_use_id ?? ''),
            content: typeof b.content === 'string' ? b.content : flattenText(b.content),
          });
          break;
        // image / document 之类上游不吃,丢掉,别让请求整体失败
      }
    }

    if (toolResults.length) {
      msgs.push(...toolResults);
      // 同一条消息里跟工具结果混在一起的文字要保留,但得排在结果之后
      if (texts.length) msgs.push({ role, content: texts.join('\n') });
      continue;
    }
    if (role === 'assistant' && toolCalls.length) {
      const assistant = { role: 'assistant', content: texts.join('\n') || null, tool_calls: toolCalls };
      if (reasoning.length) assistant.reasoning_content = reasoning.join('\n');
      msgs.push(assistant);
      continue;
    }
    const message = { role, content: texts.join('\n') };
    if (role === 'assistant' && reasoning.length) message.reasoning_content = reasoning.join('\n');
    msgs.push(message);
  }

  const out = { model: req.model, messages: msgs, stream: req.stream === true };
  if (Number.isFinite(req.max_tokens) && req.max_tokens > 0) out.max_tokens = req.max_tokens;
  if (Number.isFinite(req.temperature)) out.temperature = req.temperature;
  if (Number.isFinite(req.top_p)) out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) out.stop = req.stop_sequences;
  const tools = toolsToOpenAI(req.tools);
  if (tools) out.tools = tools;
  const tc = toolChoiceToOpenAI(req.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  const effort = reasoningEffort(req, req.model);
  if (effort) out.reasoning_effort = effort;
  // top_k 没有 OpenAI 对应字段,刻意丢掉而不是硬塞(上游会 400)
  return out;
}

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };
export const mapStop = (r) => STOP_MAP[r] ?? 'end_turn';

export const msgId = () => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 非空字符串才算有内容;上游会发 delta:{content:null} 这种占位帧 */
const str = (v) => (typeof v === 'string' && v ? v : '');

/** arguments 是 JSON 字符串,Anthropic 的 input 要对象;拼不出来就给空对象别抛 */
function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** 响应:OpenAI → Anthropic(非流式) */
export function openAIToAnthropic(oai, fallbackModel = '') {
  const choice = oai?.choices?.[0] ?? {};
  const msg = choice.message ?? choice.delta ?? {};
  const content = [];

  const reasoning = str(msg.reasoning_content) || str(msg.reasoning);
  if (reasoning) content.push({
    type: 'thinking', thinking: reasoning, signature: 'ciallo-ds4f-proxy',
  });
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: tc?.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
      name: tc?.function?.name ?? '',
      input: parseArgs(tc?.function?.arguments),
    });
  }
  // content 不能是空数组:SDK 会当成畸形响应
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const u = oai?.usage ?? {};
  return {
    id: msgId(),
    type: 'message',
    role: 'assistant',
    // 调用方传入的是已校验并实际发给上游的客户端模型；上游可能回内部别名，
    // Messages 响应仍应保持客户端看到的模型身份。
    model: fallbackModel || oai?.model || '',
    content,
    stop_reason: mapStop(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
    },
  };
}

/** Anthropic 错误体形状,和 OpenAI 的 {error:{message,type}} 不一样 */
export function anthropicError(message, type = 'api_error') {
  return { type: 'error', error: { type, message: String(message ?? '') } };
}

const HTTP_TO_ANTHROPIC_TYPE = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  504: 'api_error',
};
export const errTypeFor = (status) => HTTP_TO_ANTHROPIC_TYPE[status] ?? 'api_error';

/**
 * SSE 流翻译器。
 *
 * OpenAI 那边是一串同构的 chat.completion.chunk,Anthropic 这边是一台状态机:
 *
 *   message_start
 *     content_block_start(index 0..n,每块 text 或 tool_use)
 *       content_block_delta ×N(text_delta / input_json_delta)
 *     content_block_stop
 *   message_delta(带 stop_reason 和 output_tokens)
 *   message_stop
 *
 * 两个必须守住的点:
 *  - 事件顺序合法。SDK 是按状态机解析的,先 delta 后 start 会直接抛。
 *  - 每个 index 的 start/stop 严格配对,异常收尾也要补上,否则客户端等到超时。
 *
 * 写成「喂 chunk、吐事件」而不是直接写 res:这样能拿字符串数组断言,
 * 不用起 HTTP server 也能测出事件顺序。
 */
export class AnthropicStream {
  constructor({ model = '', emit, thinking = true }) {
    this.emit = emit;              // (event: string, data: object) => void
    this.model = model;
    this.showThinking = thinking;  // false 时推理内容丢弃(见 line() 里的说明)
    this.buf = '';
    this.started = false;
    this.nextIndex = 0;
    this.textIndex = -1;           // -1 = 文本块还没开
    this.thinkIndex = -1;          // 同上,思考块
    this.tools = new Map();        // OpenAI 的 tool_calls[].index -> {index,id,name}
    this.openBlocks = new Set();   // 已 start 未 stop 的 index
    this.stopReason = 'end_turn';
    this.usage = null;
    this.done = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId(), type: 'message', role: 'assistant', model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  blockStart(index, content_block) {
    this.openBlocks.add(index);
    this.emit('content_block_start', { type: 'content_block_start', index, content_block });
  }

  blockStop(index) {
    if (!this.openBlocks.delete(index)) return;
    this.emit('content_block_stop', { type: 'content_block_stop', index });
  }

  /** 喂上游原始字节;内部按行切,半行留着等下一块 */
  feed(chunk) {
    if (this.done) return;
    this.buf += chunk.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop();        // 末行可能被截断
    for (const line of lines) this.line(line.trim());
  }

  line(line) {
    if (!line.startsWith('data:')) return;   // 空行、注释、event: 行都跳过
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') return;        // 收尾统一在 end() 做
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }

    // 上游可能在流中途塞个错误帧
    if (obj.error) {
      this.start();
      this.emit('error', anthropicError(obj.error.message || 'upstream error', 'api_error'));
      this.end();
      return;
    }
    if (obj.model && !this.model) this.model = obj.model;
    if (obj.usage) this.usage = obj.usage;

    const choice = obj.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    this.start();

    // 推理内容。deepseek-v4-flash-free 这类模型在出正文之前会先吐几分钟
    // reasoning_content(实测「写个 SVG 动画」的提问 200s 内 reasoning 68000 字、
    // 正文 0 字)。之前这里不认这个字段,于是客户端收到 message_start 之后
    // 整整几分钟一个事件都没有 —— 看起来就是卡死/超时,而其实上游一直在吐。
    // 映射成 Anthropic 的 thinking 块,客户端就能显示「思考中」并看到进度。
    const reasoning = str(delta.reasoning_content) || str(delta.reasoning);
    if (reasoning && this.showThinking) {
      if (this.thinkIndex < 0) {
        this.thinkIndex = this.nextIndex++;
        this.blockStart(this.thinkIndex, { type: 'thinking', thinking: '' });
      }
      this.emit('content_block_delta', {
        type: 'content_block_delta', index: this.thinkIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }

    if (str(delta.content)) {
      // 正文开始 = 思考结束。Anthropic 不允许两个块同时开着,
      // 而且 SDK 的 ThinkingBlock 类型里 signature 是必填,收尾前补上。
      this.closeThinking();
      if (this.textIndex < 0) {
        this.textIndex = this.nextIndex++;
        this.blockStart(this.textIndex, { type: 'text', text: '' });
      }
      this.emit('content_block_delta', {
        type: 'content_block_delta', index: this.textIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      this.toolDelta(tc);
    }

    if (choice.finish_reason) this.stopReason = mapStop(choice.finish_reason);
  }

  /**
   * 关掉思考块。signature 是占位符,不是真签名 —— 上游没有给我们任何可签的
   * 东西。客户端把块发回来时,anthropicToOpenAI 只取 thinking 文本并还原成
   * reasoning_content,不会把占位 signature 发给上游；而缺 signature 时 SDK 会把块判为非法。
   */
  closeThinking() {
    if (this.thinkIndex < 0) return;
    this.emit('content_block_delta', {
      type: 'content_block_delta', index: this.thinkIndex,
      delta: { type: 'signature_delta', signature: 'ciallo-ds4f-proxy' },
    });
    this.blockStop(this.thinkIndex);
    this.thinkIndex = -1;
  }

  toolDelta(tc) {
    const key = Number.isFinite(tc?.index) ? tc.index : 0;
    let acc = this.tools.get(key);
    if (!acc) {
      // 文本/思考块先收掉:Anthropic 不允许两个块同时开着
      this.closeThinking();
      if (this.textIndex >= 0) { this.blockStop(this.textIndex); this.textIndex = -1; }
      acc = { index: this.nextIndex++, id: tc?.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tc?.function?.name || '' };
      this.tools.set(key, acc);
      this.blockStart(acc.index, { type: 'tool_use', id: acc.id, name: acc.name, input: {} });
    }
    // 参数按 input_json_delta 增量发,不攒齐再发 —— 攒着会让客户端干等,
    // 而按第一片就当完整(参考实现的做法)会把长参数截断
    const args = tc?.function?.arguments;
    if (typeof args === 'string' && args) {
      this.emit('content_block_delta', {
        type: 'content_block_delta', index: acc.index,
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
  }

  /** 正常收尾:补齐所有未关的块,再 message_delta / message_stop */
  end() {
    if (this.done) return;
    this.done = true;
    this.start();                  // 一个 chunk 都没收到也得有个合法的空回复
    this.closeThinking();          // 走这条才带得上 signature_delta
    for (const i of [...this.openBlocks]) this.blockStop(i);
    this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage?.completion_tokens ?? 0 },
    });
    this.emit('message_stop', { type: 'message_stop' });
  }

  /** 中途断了:先报 error 事件再按正常流程收尾,别让客户端悬着 */
  fail(message) {
    if (this.done) return;
    this.start();
    this.emit('error', anthropicError(message, 'api_error'));
    this.end();
  }
}
