/**
 * dialects.mjs —— 三种 API 方言 + 各自的流式落地方式,从 gateway.mjs 拆出来。
 *
 * 上游那几个 path 也放这儿:每个方言自带 path,轮换逻辑不用知道自己在服务谁。
 * Gateway 那边 upstreamGet / reqOpts 还要用 OPENCODE_HOST 和 MODELS_PATH,
 * 从这里 import 回去。
 */

import {
  anthropicToOpenAI, openAIToAnthropic, anthropicError, errTypeFor, AnthropicStream,
} from './anthropic.mjs';
import { json } from './http-util.mjs';

export const OPENCODE_HOST = 'opencode.ai';
export const CHAT_PATH = '/zen/v1/chat/completions';
// 上游原生支持 Responses API,走这条透传而不是翻译成 chat 再转回来(实测见
// zen-responses-native)。方言各自带上游 path,轮换逻辑不用知道自己在服务哪个。
export const RESPONSES_PATH = '/zen/v1/responses';
export const MODELS_PATH = '/zen/v1/models';


/**
 * 把上游的 reasoning_content 翻成 Anthropic 的 thinking 块。
 *
 * 默认开。deepseek-v4-flash-free 出正文之前会先推理好几分钟(实测「写个 SVG
 * 动画」的提问 200s 内推理 68000 字、正文 0 字),不转发的话客户端收到
 * message_start 之后几分钟一个事件都没有,看起来就是卡死。
 * 极少数客户端不认 thinking 块,那就 SHOW_THINKING=0 关掉。
 */
const SHOW_THINKING = process.env.SHOW_THINKING !== '0';

/**
 * 方言。/v1/chat/completions、/v1/messages、/v1/responses 共用同一套节点轮换、
 * 冷却、重试,差别只有几件事:请求怎么进来、成功体怎么写回去、错误体和 SSE
 * 事件长什么样、以及上游 path 和思考强度往哪个字段塞。把这些收进一个对象,
 * 轮换逻辑就完全不用知道自己在服务哪个 API —— 否则每个 return 点都要 if,
 * 漏一个就是形状错乱的响应。
 */
export const OPENAI = {
  name: 'openai',
  path: CHAT_PATH,
  /** 客户端选哪个模型就用哪个 —— handleChat 已经拿实时免费清单挡过一道了 */
  toUpstream: (body) => body,
  validate: (b) => (Array.isArray(b.messages) && b.messages.length ? null : 'messages required'),
  fail: (res, status, message, type, extra) => json(res, { error: { message, type, ...extra } }, status),
  // 顶层 reasoning_effort:有值覆盖,空值删掉(收敛客户端的乱值和会被丢的顶档别名)
  applyEffort: (body, effort) => { if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort; },
  respond: (res, oai) => json(res, oai),
  sink: (res) => rawSink(res),
};

export const ANTHROPIC = {
  name: 'anthropic',
  path: CHAT_PATH,
  // anthropicToOpenAI 已经把 req.model 抄进去了,这里不再覆盖
  toUpstream: (body) => anthropicToOpenAI(body),
  validate: (b) => (Array.isArray(b.messages) && b.messages.length ? null : 'messages: at least one message required'),
  // Anthropic 的错误体没有放附加字段的地方,所以把冷却剩余秒数并进 message,
  // 而不是塞个上游 SDK 会忽略掉的字段 —— 信息宁可在文字里也别丢。
  // type 参数刻意不用:Anthropic 只认自己那套枚举,按状态码映射才不会造出
  // SDK 读不懂的类型(OpenAI 那边的 invalid_model 在这儿就得是 invalid_request_error)
  fail: (res, status, message, type, extra) => {
    const s = extra?.cooldown?.[0]?.remain;
    return json(res, anthropicError(s ? `${message}(约 ${s}s 后恢复)` : message, errTypeFor(status)), status);
  },
  // anthropicToOpenAI 已经把强度转进了 reasoning_effort,这里和 OpenAI 同款收敛
  applyEffort: (body, effort) => { if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort; },
  respond: (res, oai, model) => json(res, openAIToAnthropic(oai, model)),
  sink: (res, model) => anthropicSink(res, model),
};

/**
 * OpenAI Responses API。上游原生支持(见 zen-responses-native),所以这条是
 * 近乎透传:body 形状不翻译、成功体原样回。只有两处非做不可的薄处理 ——
 *   1. 思考强度走嵌套 reasoning.effort,不是 chat 的顶层 reasoning_effort;
 *   2. 流式 sink 必须行级感知,拦掉一类模型收尾时漏出的 chat.completion.chunk
 *      杂块(见 responsesSink),纯字节透传会让严格的 Responses 客户端解析报错。
 */
export const RESPONSES = {
  name: 'responses',
  path: RESPONSES_PATH,
  // OpenAI SDK 允许 input 是字符串,但上游只认数组(纯字符串 → 400 Empty input
  // messages),所以补成数组;已经是数组的原样透传。
  toUpstream: (body) => (typeof body.input === 'string'
    ? { ...body, input: [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }] }
    : body),
  validate: (b) => ((Array.isArray(b.input) && b.input.length) || (typeof b.input === 'string' && b.input.trim())
    ? null : 'input required'),
  // Responses 的错误体和 OpenAI 同形 {error:{message,type}},复用即可
  fail: (res, status, message, type, extra) => json(res, { error: { message, type, ...extra } }, status),
  // 嵌套 reasoning.effort:保留客户端可能带的 summary 等其它 reasoning 字段,
  // 只改 effort;删到空对象就把 reasoning 整个去掉,别发个空壳上去
  applyEffort: (body, effort) => {
    const r = (body.reasoning && typeof body.reasoning === 'object') ? { ...body.reasoning } : {};
    if (effort) r.effort = effort; else delete r.effort;
    if (Object.keys(r).length) body.reasoning = r; else delete body.reasoning;
  },
  respond: (res, oai) => json(res, oai),
  sink: (res) => responsesSink(res),
};

/** OpenAI 流:上游字节原样透传,不解析不重排 */
function rawSink(res) {
  const safe = (fn) => { try { fn(); } catch {} };
  return {
    write: (chunk) => safe(() => res.write(chunk)),
    end: () => safe(() => res.end()),
    // 已经开始吐了才失败,补不了合法结尾,只能断开让客户端自己发现
    fail: () => safe(() => res.end()),
  };
}

/**
 * Responses 流:近乎透传,但要行级感知。
 *
 * 一类模型(deepseek-v4-flash / hy3 实测)收尾 usage 没翻干净:response.completed
 * 不带 usage,末尾反而漏出一个原始 {object:"chat.completion.chunk"} 再跟 [DONE]。
 * 那个杂块没有 Responses 的 type 字段,严格的 Responses 客户端(官方 SDK)碰到
 * 会解析报错,所以这里按行把它吞掉。它携带的 usage 由 forwardStream 单独抓走记账
 * (见那里的双命名兜底),不靠转发 —— 所以吞掉不影响面板 token 统计。
 *
 * 干净型模型(big-pickle / nemotron 等)根本不漏这个块,这层对它们等同透传。
 */
function responsesSink(res) {
  const safe = (fn) => { try { fn(); } catch {} };
  let buf = '';
  // 按行判断:只有确认是 chat.completion.chunk 的 data 行才丢,其余(response.*
  // 事件、空行、[DONE]、解析不了的行)一律原样转发,保住 SSE 分帧。
  const forwardLine = (line) => {
    if (line.startsWith('data:')) {
      const payload = line.slice(line.indexOf(':') + 1).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const j = JSON.parse(payload);
          if (j && j.object === 'chat.completion.chunk') return;
        } catch {}
      }
    }
    safe(() => res.write(line + '\n'));
  };
  return {
    write: (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();          // 末行可能被截断,留着等下一个 chunk
      for (const line of lines) forwardLine(line);
    },
    end: () => { if (buf) { forwardLine(buf); buf = ''; } safe(() => res.end()); },
    fail: () => safe(() => res.end()),
  };
}

/** Anthropic 流:把上游的 chat.completion.chunk 翻译成 Messages 事件流 */
function anthropicSink(res, model) {
  const safe = (fn) => { try { fn(); } catch {} };
  const st = new AnthropicStream({
    model,
    thinking: SHOW_THINKING,
    emit: (event, data) => safe(() => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
  });
  return {
    write: (chunk) => st.feed(chunk),
    end: () => { st.end(); safe(() => res.end()); },
    // 和 rawSink 不同:这里能补一个合法收尾(error + message_stop),
    // 客户端的状态机于是能正常结束,而不是等到超时
    fail: (msg) => { st.fail(msg); safe(() => res.end()); },
  };
}

