/**
 * gateway.mjs —— OpenAI 兼容网关 + 节点轮换状态机。
 *
 * 从 desktop-app/gateway.js 移植。行为(冷却、锁定节点、429 换人、
 * 网络错误只重试当前节点)刻意保持一致,唯一实质改动是出站真的走 mihomo 了
 * —— 详见 proxy.mjs 顶部那段 bug 说明。
 *
 * 核心策略没变:一个 IP 能用就一直用,直到 429 才换。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MihomoAgent } from './proxy.mjs';
import {
  LAST_NODE_FILE, USAGE_FILE, CAPS_FILE, MODELS_DEV_FILE,
  MIXED_PORT, CTRL_PORT, POOL_NAME, lanePorts, laneDataDir, writeMihomoConfig,
} from './config.mjs';
import { MihomoInstance } from './mihomo.mjs';
import { LaneManager } from './lane.mjs';
import {
  anthropicToOpenAI, openAIToAnthropic, anthropicError, errTypeFor, AnthropicStream, flattenText,
  reasoningEffort, setModelEfforts,
} from './anthropic.mjs';
import { Capabilities } from './capabilities.mjs';
import { ModelMetadataStore, MODELS_DEV_TTL_MS } from './model-metadata.mjs';
import { ModelAvailability, MODEL_AVAILABILITY_TTL_MS } from './model-availability.mjs';
import { safeEqual } from './auth.mjs';
import { classifyUpstreamError, upstreamErrorMessage } from './upstream-errors.mjs';

export { classifyUpstreamError } from './upstream-errors.mjs';
export { ModelAvailability, MODEL_AVAILABILITY_TTL_MS } from './model-availability.mjs';

const OPENCODE_HOST = 'opencode.ai';
const CHAT_PATH = '/zen/v1/chat/completions';
// 上游原生支持 Responses API,走这条透传而不是翻译成 chat 再转回来(实测见
// zen-responses-native)。方言各自带上游 path,轮换逻辑不用知道自己在服务哪个。
const RESPONSES_PATH = '/zen/v1/responses';
const MODELS_PATH = '/zen/v1/models';
// 429 但上游没给 Retry-After 时的兜底冷却。配套「解冻排队尾」(见 rankNodes):
// 解冻的节点不再凭低延迟插回队首,而是排到没限流过的节点后面,所以短冷却不会再
// 造成「解冻→立刻重打→再冻」的高频刷屏。60s 足够躲开一阵限流窗口,又能在其余
// 节点也不行时较快回来重试。带 Retry-After 的仍按上游给的时长走(见 mark429)。
export const COOLDOWN_MS = 60 * 1000;
export const MODEL_COOLDOWN_MS = 15 * 60 * 1000;
// 节点封域(机场在 CONNECT/TLS 层拒连 opencode.ai)的冷却。这不是限流,是确定性
// 故障:同一节点短时间内不会自己好,但机场可能几小时后换线路,所以取 30 分钟 ——
// 比无 Retry-After 的 429(60s)长得多,又不用等一天。
export const BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;
// 并发分摊:主 lane 忙时最多再拉起几个独立出口,每个子 lane 空闲满这个时间就回收。
// 主 lane 常驻负责订阅刷新和默认出站;子 lane 只在真正并发时才存在,平时和现状一样。
// env 可调(ZEN_MAX_CHILD_LANES),config.json 里存的 maxChildLanes 优先。
export const MAX_CHILD_LANES = Number(process.env.ZEN_MAX_CHILD_LANES) || 2;
export const LANE_IDLE_MS = 5 * 60 * 1000;

/**
 * 从远端日志钉死的三类「机场节点拒绝代理 opencode.ai」,加上 CONNECT 直接回 403:
 *   - Client network socket disconnected before secure TLS connection was established
 *     (mihomo 日志里对应 dial ... err code: 403,CONNECT 阶段被拒)
 *   - Hostname/IP does not match certificate's altnames ...(DNS 劫持到别的站)
 *   - EPROTO ... tlsv1 unrecognized name / SSL alert number 112(SNI 封锁)
 * 它们全是确定性的:重试同一节点只会把每次请求拖长 40-90s,直接换下一个。
 */
export function isNodeBlockedError(e) {
  const text = String(e?.body ?? e?.message ?? '');
  return /disconnected before secure TLS connection was established|does not match certificate's altnames|tlsv1 unrecognized name|SSL alert number 112|CONNECT[^\n]*(?:403|拒绝)/i.test(text);
}
// availability 不是节点限流:没有节点时状态探测最多每分钟尝试一次,避免面板轮询
// 把 mihomo 控制端口和上游一起打满。真正的成功/失败结果六小时才过期。
const MODEL_AVAILABILITY_RETRY_MS = 60 * 1000;

/**
 * SSE 心跳间隔。宝塔 nginx 默认 proxy_read_timeout 60s,客户端(OpenCode CLI、
 * 浏览器)也各有自己的空闲上限 —— 静默一旦超过其中最短的那个,连接就被中间层
 * 掐掉,而网关这侧还在正常收流,于是表现为「长任务莫名截断」。15s 给三倍余量。
 */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * 流式连接的保活器。
 *
 * 原来的心跳只活到首字节:上游一开口就 clearInterval。这在「思考完就一口气吐
 * 完」的模型上够用,长任务上不够 —— 实测长任务的静默不在开头而在中段:模型吐
 * 一段 reasoning 后停下来想下一步、或者工具调用之间空转,几分钟没有任何字节。
 * 那时心跳已经关了,nginx 60s 一到就断,客户端看到的是流被截断。
 *
 * 所以保活要覆盖整条流,直到 end/error 才停。`touch()` 在每次真实数据到达时
 * 调用:只有「距上次数据超过一个间隔」才补 ping,活跃的流里一个字节都不多发。
 *
 * `: ping` 是 SSE 规范里的注释行,所有合规客户端都会忽略,不会污染业务事件。
 */
export class StreamKeepAlive {
  constructor(write, { interval = SSE_HEARTBEAT_MS, now = () => Date.now(),
    setTimer = setInterval, clearTimer = clearInterval } = {}) {
    this.write = write;
    this.interval = interval;
    this.now = now;
    this.clearTimer = clearTimer;
    this.last = now();
    this.pings = 0;
    this.timer = setTimer(() => this.tick(), interval);
    // 心跳不该让进程为了它多活一秒 —— 真正决定生命周期的是那条流
    this.timer?.unref?.();
  }

  /** 到点检查:只有静默满一个间隔才发 ping,活跃的流不插东西 */
  tick() {
    if (this.now() - this.last < this.interval) return;
    try { this.write(': ping\n\n'); this.pings++; } catch { this.stop(); }
  }

  /** 真实数据到达 —— 重置静默计时,这一拍不用 ping */
  touch() { this.last = this.now(); }

  stop() {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

/**
 * 解析 Retry-After 响应头,返回秒数(null 表示没有或解析失败)。
 * 格式二选一:相对秒数(120)或 HTTP-date(Tue, 13 Aug 2026 00:00:00 GMT)。
 */
function parseRetryAfter(value) {
  if (!value) return null;
  const s = String(value).trim();
  // 纯数字 → 相对秒数
  if (/^\d+$/.test(s)) {
    const sec = parseInt(s, 10);
    return sec > 0 && sec < 86400 * 2 ? sec : null;  // 上限两天,防止解析错误
  }
  // HTTP-date → 转成相对秒数
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const sec = Math.max(0, Math.floor((t - Date.now()) / 1000));
    return sec < 86400 * 2 ? sec : null;
  }
  return null;
}

/**
 * 时间预算。这几个数一起决定「最坏多久给客户端一个答复」。
 *
 * 之前没有总预算,只有 for (i <= nodes.length + 5) 这个次数上限:48 个节点
 * 就是 53 轮,每轮还能网络重试 3 次 × 60s,最坏 2.6 小时。客户端 90 秒就断了,
 * 于是显示的是它自己的兜底文案(「模型不存在」),真实原因完全看不见。
 *
 * 所以改成时间驱动:超预算立刻回一个真错误。宁可让客户端看到 504,
 * 也不能让它挂到超时 —— 挂着连日志都对不上号。
 */
export const REQUEST_DEADLINE_MS = 300_000;  // 一个请求从进来到回复的上限(小请求的基线)
const UPSTREAM_TIMEOUT_MS = 120_000;         // 单次请求的静默上限(非流式的整段等待 / 流式的首字节)
const STREAM_IDLE_MS = 300_000;              // 流式:开始吐了以后允许的静默
const MAX_NODE_TRIES = 6;                    // 最多换几个节点。48 个全试一遍没意义:
                                             // 连续 6 个都 429 基本就是整体被限了
const MIN_TRY_MS = 8_000;                    // 剩这么点时间就别再开新的尝试了

/**
 * 上面两个上限都按请求体积放大。免费清单里有 6 个模型是 1M 级上下文(见 README
 * 的模型表),那种请求体有 4-5 MiB,固定 75s / 45s 装不下:
 *
 *   实测直连上游,1M 上下文的 prefill 要 28-129s(同一尺寸重跑能差三倍),
 *   网关这侧还得先把这几 MB 经 mihomo 传上去。原来 256K 就已经过不去了,
 *   而且烧穿预算之后报的是「节点全挂」—— 把慢误判成坏,见 giveUp。
 *
 * 按体积连续放大而不是分档,免得 0.9 MiB(约 200K 上下文)这种刚好卡在档位下面
 * 一点的请求一分钟都拿不到。几 KB 的小请求加出来不到一秒,行为和以前一样。
 *
 * ponytail: 用体积当 prefill 时间的代理指标,没真去数 token。够 1Mi 用(实测最坏
 * 94s 加上传);要更准就得先 tokenize,那是另一件事。上限 420s / 240s 是拍的,
 * 只求装得下实测最坏值还留一倍余量。
 *
 * 注意流式并不吃这个亏:实测 1M 请求的首字节也只要 7.5s(上游不等 prefill 走完
 * 才开口),放宽对它只是保险。真正被固定预算掐死的是非流式。
 */
export const budgetFor = (bytes) => Math.min(900_000, REQUEST_DEADLINE_MS + Math.round((bytes / 1048576) * 75_000));
export const silentFor = (bytes) => Math.min(600_000, UPSTREAM_TIMEOUT_MS + Math.round((bytes / 1048576) * 45_000));

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
 * 延迟探针地址。默认就是上游本身 —— 「这个节点可用」在这儿只有一个意思:
 * 能把请求送到 opencode.ai。HEAD 一下站点根路径,不碰 /zen/v1,不花额度,
 * 任何状态码都算通(要的只是「TLS 能握上、有回应」)。
 *
 * 原来默认 http://www.gstatic.com/generate_204,实测一份 17 节点的订阅全测
 * 不通,而同一批节点跑上游是好的:机场封 80 端口、劫持 Google 域名都很常见。
 * 探针本身到不了,就会把能用的节点全判死 —— 那比不测更糟。
 */
const HEALTH_URL = process.env.NODE_TEST_URL || `https://${OPENCODE_HOST}/`;

/** 单次探测超时。内核那边 timeout 按 int16 解析(超过 32767 直接 400),整组
 *  测完还得在 mihomoApi 的 10 秒里回来 —— 夹到 1..8 秒,两头都不越界。 */
const HEALTH_TIMEOUT_MS = Math.min(Math.max(Number(process.env.NODE_TEST_TIMEOUT_MS) || 5_000, 1_000), 8_000);

/**
 * 免费模型清单的兜底值。真值从上游 /zen/v1/models 现拉(见 pickFreeModels /
 * freeModels),这里只是冷启动和拉不到时用的常量 —— 面板上那一列宁可旧一点,
 * 也不能因为一次网络抖动变空。
 *
 * 写死过一次的代价:上游后来加了 longcat-2.0-free,而这份列表没人记得改,
 * 面板于是少列一个能用的模型。所以现在它只是 fallback。这份是 2026-08-21
 * 核对上游清单的结果:8 个 —— 2026-08-11 拉到的 11 个里,ling-3.0-flash/tiny-free、
 * longcat-2.0-free、north-mini-code-free 这 4 个已经下线,外加当天上线的
 * x-preview-f-free。
 *
 * 下线的那 4 个从这里删掉了,但它们的**实测记录留着**(server/capabilities.mjs
 * 的 SEED):记录是一张按 id 查的字典,清单里没有它就不显示,哪天回来了 id 一样
 * 直接复用,不用再探一遍。早先不敢删是因为删了要连带动一张手写的上下文表和三处
 * 测试断言 —— 那张表现在不手写了。
 *
 * 注意「在清单里」不等于「此刻能出结果」:2026-08-11 实测 11 个里 4 个是坏的
 * (hy3-free 402 免费额度耗尽、ling-3.0-flash/tiny-free 503 Endpoint is
 * unavailable、north-mini-code-free 401),换出口 IP 重试同样失败,是上游
 * 供应商侧的问题。这里照列不筛 —— 逐个探活要一次出站一个模型、慢的单次就
 * 10 秒,而且坏的会自己好;真发请求时上游的错误会原样回给客户端。
 */
export const FREE_MODELS = [
  'big-pickle',
  'deepseek-v4-flash-free',
  'hy3-free',
  'laguna-s-2.1-free',
  'mimo-v2.5-free',
  // 2026-08-21 上线。实测是**坏的**:不管发什么都回一个没有 error 字段的
  // 「成功壳子」配一个怪状态码(基线 400、max_tokens=9e8 却是 429),
  // 只有普普通通的一次对话能回 200。列着是因为它确实在上游清单上
  'muse-spark-1.2-contributor-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  // Ox Alpha(上游文档里的显示名是「Ox Alpha Free」,id 没带这三个字)。
  // 2026-08-20 上线的匿名 stealth 模型,免费一周,别按 id 猜它是什么。
  'x-preview-f-free',
];

/**
 * 免费清单的 TTL。上游几周才动一次,拉太勤没意义(还多一次出站),
 * 所以一天一次;真正保证「不旧」的是开机那一次(见 index.mjs 的 main)。
 */
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 从上游那份「全部模型」里挑出免费的。
 *
 * /zen/v1/models 会列 60+ 个,绝大多数是付费的(claude-* / gpt-* / gemini-*),
 * 而本网关不带 Authorization 出站,付费模型必然 401 —— 列出来就是骗人。
 * 判据只能靠 id:`-free` 后缀,外加 big-pickle 这个没后缀但确实在免费清单里的
 * 例外(上游没给任何价格字段,只能这么认)。
 *
 * ponytail: 上游哪天给免费模型换个命名法,这里会漏掉它们,那时靠调用方的
 * fallback 顶着(不会变空),改的话就是往 EXTRA_FREE 里加一条。
 */
const EXTRA_FREE = new Set(['big-pickle']);

export function pickFreeModels(ids) {
  const seen = new Set();
  for (const raw of ids || []) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    if (id.endsWith('-free') || EXTRA_FREE.has(id)) seen.add(id);
  }
  return [...seen];
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 客户端请求口径的桶:一个客户端请求记一次 */
const blankTotals = () => ({
  requests: 0, success: 0, fail: 0,
  promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0,
});

/**
 * 节点尝试口径的桶:每次真实发出的上游 HTTP 请求记一次。
 *
 * 和上面那套刻意分开:一个客户端请求可能先撞 429、再超时、最后在第三个节点
 * 成功 —— 顶部总览要显示「1 次成功」,而这里要显示三次尝试各自的归属。
 * 混在一个数里的话「换了几个节点」和「客户端失败了几次」永远分不出来。
 */
const NODE_OUTCOMES = ['success', 'rateLimited', 'timeout', 'upstreamError'];

const blankNode = () => ({
  requests: 0, ...Object.fromEntries(NODE_OUTCOMES.map((k) => [k, 0])),
  promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, hasCacheData: false,
  // 耗时只累计成功的尝试:429 被秒拒也很「快」,混进去会把限流最狠的节点
  // 显示成最快的那个。样本数单独记而不复用 success —— 旧桶里的 success
  // 是没有耗时数据的那些,拿它当分母会把平均值算低。
  ttfbMs: 0, ttfbCount: 0, durationMs: 0, durationCount: 0,
  // 面板按这个倒序排:哪个节点现在正在用,比哪个节点历史上跑得多有用。
  // 0 而不是 null —— 旧桶归一化后直接参与比较,不用在前端兜 null
  lastAt: 0,
  // 最近一次尝试发出去的模型和思考强度。只留最近一次而不按模型分桶:面板本来
  // 就按 lastAt 倒序显示「这个节点刚才在跑什么」,历史分布是 byModel 的活。
  // effort 为 '' = 没发这个字段,随上游默认 —— 和「发了 high」是两回事,
  // 排查「客户端设了 max 却没生效」时区别就在这儿。
  lastModel: '', lastEffort: '',
});

/**
 * 调用日志保留多少条。
 *
 * 按节点聚合的桶只留得下「最近一次」,而排查思考强度、模型、耗时这类问题要的是
 * 「每一次分别是什么」—— 同一个节点连着跑十次不同档位,聚合桶里只剩最后一次。
 *
 * ponytail: 上限写死 200 条,不做按时间过期。usage.json 是整份读写的,再大
 * 就该换 append-only 的日志文件了 —— 那是另一件事,现在没到那个量。
 * 200 条 × 约 120 字节 ≈ 24KB,对一个本来就几 KB 的 JSON 可以接受。
 */
export const CALL_LOG_LIMIT = 200;

/**
 * 上游 usage → 统一字段名。
 *
 * 两套命名都认:chat 是 prompt_tokens/completion_tokens,Responses 是
 * input_tokens/output_tokens(见 zen-responses-native)。缓存 token 各家字段名
 * 也不一样,而上游会把底层模型的 usage 原样带出来,所以见到哪个认哪个:
 * OpenAI 是 prompt_tokens_details.cached_tokens,Responses 是
 * input_tokens_details.cached_tokens,Anthropic 风格是 cache_read_input_tokens /
 * cache_creation_input_tokens。一个都没有时 token 仍归一成 0,另用 hasCacheData
 * 标明「无数据」,避免面板把「上游没报」误显示成「明确 0%」。
 */
export function readUsage(u) {
  // ?? 而不是 ||:上游明确报的 0 是有意义的,不能被另一套命名顶掉
  const pt = Number(u?.prompt_tokens ?? u?.input_tokens) || 0;
  const ct = Number(u?.completion_tokens ?? u?.output_tokens) || 0;
  const num = (...vals) => {
    for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
    return 0;
  };
  const has = (...paths) => paths.some(([obj, key]) => obj != null && Object.hasOwn(obj, key));
  return {
    promptTokens: pt,
    completionTokens: ct,
    reasoningTokens: Number(u?.completion_tokens_details?.reasoning_tokens
      ?? u?.output_tokens_details?.reasoning_tokens) || 0,
    totalTokens: Number(u?.total_tokens) || pt + ct,
    cacheReadTokens: num(u?.prompt_tokens_details?.cached_tokens, u?.input_tokens_details?.cached_tokens,
      u?.cache_read_input_tokens, u?.prompt_cache_hit_tokens),
    cacheWriteTokens: num(u?.cache_creation_input_tokens, u?.prompt_tokens_details?.cache_creation_tokens),
    hasCacheData: has(
      [u?.prompt_tokens_details, 'cached_tokens'], [u?.input_tokens_details, 'cached_tokens'],
      [u, 'cache_read_input_tokens'], [u, 'prompt_cache_hit_tokens'], [u, 'cache_creation_input_tokens'],
      [u?.prompt_tokens_details, 'cache_creation_tokens'],
    ),
  };
}

/** 客户端可以自己带的那几个身份头。带了就透传,没带的按下面的默认值补 */
const IDENTITY_DEFAULTS = {
  'User-Agent': 'opencode-cli/1.0.0',
  'x-opencode-client': 'cli',
  'x-opencode-project': 'default',
};

function contentSignal(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = [];
    let textOnly = true;
    for (const block of content) {
      if (typeof block === 'string') {
        text.push(block);
      } else if ((block?.type === 'text' || block?.type === 'input_text') && typeof block.text === 'string') {
        text.push(block.text);
      } else {
        textOnly = false;
      }
    }
    if (textOnly && text.length) return text.join('');
  }
  try { return JSON.stringify(content) || ''; } catch { return ''; }
}

/** 第一条 user 内容不会随对话历史增长,适合做无显式 ID 时的稳定会话种子。 */
function conversationSeed(body) {
  if (typeof body?.input === 'string' && body.input) return body.input;
  for (const field of ['messages', 'input']) {
    for (const item of Array.isArray(body?.[field]) ? body[field] : []) {
      if (item?.role !== 'user') continue;
      const signal = contentSignal(item.content);
      if (signal && signal !== 'null') return signal;
    }
  }
  return '';
}

function stableSessionId(signal) {
  const hash = crypto.createHash('sha256').update(`ses\0${signal}`).digest('hex');
  return `ses_${hash.slice(0, 24)}`;
}

/**
 * 合成 OpenCode CLI 的身份头(实验开关,默认关)。
 *
 * 为什么值得试:上游的 prompt cache 很可能按会话/客户端身份分桶,而我们出站
 * 一直是裸 `User-Agent: node`。补上真实 CLI 的那组头之后能不能拿到缓存
 * usage,是这个开关唯一要观察的事 —— 它不改额度、也不改节点调度。
 *
 * request/session ID 必须在同一个客户端请求的多次节点重试之间保持不变:
 * 每次重试换一个 ID 的话,上游看到的就是几个互不相干的新会话,缓存必然不命中,
 * 这个实验也就白做了。所以在 handleChat 里构造一次,再传给每次尝试。
 */
export function identityHeaders(inbound, uuid = () => crypto.randomUUID()) {
  const h = {};
  for (const [k, v] of Object.entries(inbound?.headers || {})) h[k.toLowerCase()] = v;
  const pick = (...names) => {
    for (const n of names) {
      const v = h[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const out = { ...IDENTITY_DEFAULTS };
  for (const [name, dflt] of Object.entries(IDENTITY_DEFAULTS)) {
    out[name] = pick(name.toLowerCase()) || dflt;
  }
  out['x-opencode-request'] = pick('x-opencode-request') || uuid();
  const body = inbound?.body;
  const explicitSession = pick('x-opencode-session', 'x-session-id', 'conversation-id', 'x-session-affinity')
    || (typeof body?.conversation_id === 'string' ? body.conversation_id.trim() : '')
    || (typeof body?.metadata?.session_id === 'string' ? body.metadata.session_id.trim() : '');
  const seed = conversationSeed(body);
  out['x-opencode-session'] = explicitSession || (seed ? stableSessionId(seed) : uuid());
  // 这两个没有合理的默认值,客户端没给就别凭空造
  for (const n of ['x-session-id', 'x-title']) {
    const v = pick(n);
    if (v) out[n] = v;
  }
  return out;
}

/**
 * 按底层供应商推断模型分组。限流实测:DS4F/big-pickle/mimo/longcat 同时被限,
 * 而 nemotron 系照常可用 —— 上游是按供应商分别计额度的。模型清单里没有供应商
 * 字段,只能靠命名规律推断。后续上游暴露了供应商字段就改成读那个。
 */
export function providerGroup(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('nemotron')) return 'nemotron';
  if (m.startsWith('ling-')) return 'ling';
  if (m.startsWith('laguna')) return 'laguna';
  // DS4F / big-pickle / mimo / longcat / hy3 / north 归默认组
  return 'default';
}

/**
 * session+model 到 mihomo 节点的轻量绑定表。
 *
 * 这里只负责选点,不持有 transport、不自行发请求。Map 的插入顺序同时充当 LRU,
 * 防止长期运行时一次性会话无限堆积；负载就是当前仍保留的绑定数。
 */
export class NodeAffinity {
  constructor(limit = 2048) {
    this.limit = Math.max(1, Number(limit) || 2048);
    this.bindings = new Map();
    this.loads = new Map();
  }

  key(session, model) {
    const s = typeof session === 'string' ? session.trim() : '';
    const m = typeof model === 'string' ? model.trim() : '';
    return s && m ? JSON.stringify([s, m]) : '';
  }

  get(key) { return key ? this.bindings.get(key) || null : null; }
  load(node) { return this.loads.get(node) || 0; }

  #bump(node, delta) {
    const n = this.load(node) + delta;
    if (n > 0) this.loads.set(node, n); else this.loads.delete(node);
  }

  bind(key, node) {
    if (!key || !node) return node || null;
    const current = this.bindings.get(key);
    if (current === node) {
      this.bindings.delete(key);
      this.bindings.set(key, node);
      return node;
    }
    if (current) this.release(key, current);
    while (this.bindings.size >= this.limit) {
      const oldest = this.bindings.keys().next().value;
      this.release(oldest);
    }
    this.bindings.set(key, node);
    this.#bump(node, 1);
    return node;
  }

  release(key, node = null) {
    if (!key) return false;
    const current = this.bindings.get(key);
    if (!current || (node && current !== node)) return false;
    this.bindings.delete(key);
    this.#bump(current, -1);
    return true;
  }

  /**
   * 单节点优先:新绑定一律落 preferred(全局 lockedNode = 当前节点),已有绑定
   * 粘自己的。额度按出口 IP 算,把会话摊到多个出口等于每份额度都只用到一半;
   * 而且全局 selector 只有一个,并发分散选址必然互相拔节点(乱跳的根因)。
   * 迁移只在失败(429/封域/5xx)时发生,由 attempt 的换节点路径驱动。
   *
   * loads 计数保留:面板统计和 LRU 还用得着,但不再参与选址。
   */
  pick(key, nodes, { available = () => true, exclude = null, preferred = null } = {}) {
    const candidates = (nodes || []).filter((node) => !exclude?.has(node) && available(node));
    const current = this.get(key);
    if (current && candidates.includes(current)) return this.bind(key, current);
    if (current) this.release(key, current);
    if (!candidates.length) return null;

    // 没有 key 的调用(旧路径)和新绑定行为一致:preferred 在候选里就落它
    if (preferred && candidates.includes(preferred)) return this.bind(key, preferred);
    return this.bind(key, candidates[0]);
  }

  migrate(key, failedNode, nodes, options = {}) {
    this.release(key, failedNode);
    const exclude = new Set(options.exclude || []);
    if (failedNode) exclude.add(failedNode);
    // 迁移时也粘 preferred(当前节点),不往零负载节点散 —— 单节点优先的延续
    return this.pick(key, nodes, { ...options, exclude });
  }

  dropNode(node) {
    let dropped = 0;
    for (const [key, bound] of [...this.bindings]) {
      if (bound === node && this.release(key, node)) dropped++;
    }
    return dropped;
  }

  clear() {
    const n = this.bindings.size;
    this.bindings.clear();
    this.loads.clear();
    return n;
  }
}

/**
 * 429 后把节点关小黑屋,期间跳过它,避免连续请求撞同一个被限的出口。
 *
 * 限流按「节点 × 供应商组」分别记:同一节点上 DS4F 被限不影响 nemotron 继续用。
 * 冷却时长优先读上游的 Retry-After(实测指向 UTC 零点的日额度重置),没给就兜底 COOLDOWN_MS。
 */
export class NodeCooldown {
  constructor() {
    this.cooldowns = new Map();   // "node:group" -> { until, retryAfter };过期即删,summary 才干净
    // "node:group" -> 最近一次被限流的时刻。冷却过期会把上面那条删掉,但这条留着,
    // rankNodes 靠它把刚解冻的节点排到可用节点最后(见 recentMark)。只有 clear/clearAll 清。
    this.lastMarked = new Map();
  }
  #key(node, group = 'default') { return `${node}:${group}`; }

  mark429(node, group = 'default', retryAfterSec = null) {
    const ms = retryAfterSec != null && retryAfterSec > 0
      ? Math.min(retryAfterSec * 1000, 24 * 3600 * 1000)  // 上限一天,防止解析错误
      : COOLDOWN_MS;
    const key = this.#key(node, group);
    this.cooldowns.set(key, { until: Date.now() + ms, retryAfter: retryAfterSec });
    this.lastMarked.set(key, Date.now());
  }

  /**
   * 封域冷却。和 429 共用一张表(跳过逻辑一样),但时长独立、不带 retryAfter,
   * summary 里标 reason 让面板能区分「被限流」和「被机场封了」。
   */
  markBlocked(node, group = 'default') {
    this.cooldowns.set(this.#key(node, group), { until: Date.now() + BLOCKED_COOLDOWN_MS, retryAfter: null, blocked: true });
    this.lastMarked.set(this.#key(node, group), Date.now());
  }

  /**
   * 5xx 秒拒冷却。上游(zen)对爆满的出口直接秒回 5xx,这种坏节点用 429 同款
   * 短冷却(COOLDOWN_MS),让整批坏出口在一段时间内被排到队尾,而不是每来一个
   * 请求都优先挑到延迟最低的这批(它们延迟最低,专挑坏的打)。reason 标
   * '5xx' 让面板能区分「被限流(429)」「被机场封(blocked)」「上游 5xx」。
   */
  mark5xx(node, group = 'default') {
    const now = Date.now();
    const key = this.#key(node, group);
    const until = now + COOLDOWN_MS;
    const existing = this.cooldowns.get(key);
    // 并发请求可能交错落标记:不能让 5xx 的 60s 覆盖更强的 429
    // Retry-After 或机场封域冷却,否则会把 1h/30min 错缩成 60s。
    if (!existing || existing.until <= now || existing.until < until) {
      this.cooldowns.set(key, { until, retryAfter: null, reason: '5xx' });
    }
    this.lastMarked.set(key, now);
  }

  /** 返回仍在生效的节点冷却详情;过期项顺手清掉。 */
  get(node, group = 'default') {
    const key = this.#key(node, group);
    const c = this.cooldowns.get(key);
    if (!c) return null;
    const remain = c.until - Date.now();
    if (remain <= 0) {
      this.cooldowns.delete(key);
      return null;
    }
    return { ...c, remain };
  }

  isCooling(node, group = 'default') {
    return this.get(node, group) !== null;
  }

  clear(node, group = null) {
    if (group === null) {
      // 清该节点所有分组(冷却记录和「最近限流时刻」一起清,恢复它的正常优先级)
      let n = 0;
      for (const k of [...this.cooldowns.keys()]) {
        if (k.startsWith(`${node}:`)) { this.cooldowns.delete(k); n++; }
      }
      for (const k of [...this.lastMarked.keys()]) {
        if (k.startsWith(`${node}:`)) this.lastMarked.delete(k);
      }
      return n;
    }
    const key = this.#key(node, group);
    this.cooldowns.delete(key);
    this.lastMarked.delete(key);
    return 1;
  }

  clearAll() {
    const n = this.cooldowns.size;
    this.cooldowns.clear();
    this.lastMarked.clear();
    return n;
  }

  /**
   * 该节点最近一次(任意分组)被限流的时刻,含已解冻的;没限流过返回 0。
   * rankNodes 拿它把刚限流/解冻的节点排到可用节点最后 —— 否则延迟最低的那个
   * 一解冻就凭低延迟插回队首、又被打,后面的节点永远轮不到。成功(clear)后归零。
   */
  recentMark(node) {
    let ts = 0;
    for (const [k, t] of this.lastMarked) {
      if (k.startsWith(`${node}:`)) ts = Math.max(ts, t);
    }
    return ts;
  }

  pickAvailable(nodes, group = 'default', exclude = null) {
    for (const n of nodes) {
      if (exclude?.has(n)) continue;
      if (this.isCooling(n, group)) continue;
      return n;
    }
    return null;
  }

  /** 全员冷却时挑该分组剩余最短的,返回 { node, remain }(remain 单位 ms) */
  soonest(nodes, group = 'default') {
    let node = null, remain = Infinity;
    for (const n of nodes) {
      const c = this.get(n, group);
      if (c && c.remain < remain) { remain = c.remain; node = n; }
    }
    return node ? { node, remain } : null;
  }

  /** 供 /api/nodes 用,remain 单位秒。返回该节点所有分组的冷却状态 */
  summary() {
    const out = [];
    for (const [k, c] of this.cooldowns) {
      const left = c.until - Date.now();
      if (left <= 0) continue;
      const [node, group] = k.split(':');
      out.push({
        node,
        group,
        remain: Math.ceil(left / 1000),
        retryAfter: c.retryAfter,
        blocked: c.blocked === true,
        reason: c.reason
      });
    }
    return out;
  }
}

/** 上游明确说模型不可用时,短暂跳过该模型,不要继续消耗其它出口额度。 */
export class ModelCooldown {
  constructor(ttlMs = MODEL_COOLDOWN_MS) {
    this.ttlMs = ttlMs;
    this.cooldowns = new Map(); // model -> { until, message }
  }

  mark(model, message = '') {
    const id = String(model ?? '').trim();
    if (!id) return;
    this.cooldowns.set(id, { until: Date.now() + this.ttlMs, message: String(message || '') });
  }

  get(model) {
    const id = String(model ?? '').trim();
    const entry = this.cooldowns.get(id);
    if (!entry) return null;
    const remain = entry.until - Date.now();
    if (remain <= 0) {
      this.cooldowns.delete(id);
      return null;
    }
    return { ...entry, remain: Math.ceil(remain / 1000) };
  }

  isCooling(model) { return this.get(model) !== null; }

  clear(model) {
    const id = String(model ?? '').trim();
    return id ? this.cooldowns.delete(id) : false;
  }

  clearAll() {
    const n = this.cooldowns.size;
    this.cooldowns.clear();
    return n;
  }

  summary() {
    const out = [];
    for (const [model] of this.cooldowns) {
      const entry = this.get(model);
      if (entry) out.push({ model, remain: entry.remain, message: entry.message });
    }
    return out;
  }
}

/** token 用量统计,持久化到 /data,重启不丢 */
export class UsageTracker {
  /**
   * persist = false 时整个统计只在内存里,不读盘也不写盘 —— 面板上那个
   * 「统计数据持久储存」开关关掉之后,进程一重启统计就从零开始。
   * 开关是运行时可切的,所以这里把开关留成可变的 this.persist,而不是构造时定死。
   */
  constructor(filePath = USAGE_FILE, logger = null, persist = true) {
    this.filePath = filePath;
    this.logger = logger;
    this.persist = persist;
    this.data = this.load();
  }
  load() {
    try {
      if (this.persist && fs.existsSync(this.filePath)) {
        const d = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        // 字段都是逐步加的:旧桶和空桶合并默认值,既保留历史数,
        // 又避免后续做 `undefined += 2` 变成 NaN(JSON 落盘时会写成 null)
        if (d?.total) {
          const normalize = (map, blank) => Object.fromEntries(Object.entries(map || {})
            .map(([name, value]) => [name, { ...blank(), ...value }]));
          return {
            ...d,
            total: { ...blankTotals(), ...d.total },
            byDay: normalize(d.byDay, blankTotals),
            byModel: normalize(d.byModel, blankTotals),
            byNode: normalize(d.byNode, blankNode),
            // 旧文件没有 calls;补空数组而不是编造历史条目 —— 聚合桶里的
            // lastModel/lastEffort 只够还原最近一次,拆不出逐条记录
            calls: Array.isArray(d.calls) ? d.calls.slice(-CALL_LOG_LIMIT) : [],
          };
        }
      }
    } catch (e) { this.logger?.('warn', `[usage] 读取失败: ${e.message}`); }
    return this.blank();
  }
  blank() {
    return { total: blankTotals(), byDay: {}, byModel: {}, byNode: {}, calls: [], lastRequest: null, startTime: Date.now() };
  }
  save() {
    if (!this.persist) return;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) { this.logger?.('warn', `[usage] 保存失败: ${e.message}`); }
  }

  /**
   * 运行时切换持久化开关。开的那一下把当前(内存里的)统计落一次盘,
   * 让之后的重启能接着这份数而不是从零开始;关掉只是停写,已经写的文件不动。
   */
  setPersist(on) {
    const was = this.persist;
    this.persist = on === true;
    if (this.persist && !was) this.save();
    return this.persist;
  }
  /** 客户端请求口径:一个客户端请求一次,不管中间换了几个节点 */
  record(model, usage, success) {
    const day = new Date().toISOString().slice(0, 10);
    const u = readUsage(usage);

    this.data.byDay[day] ??= blankTotals();
    this.data.byModel[model] ??= blankTotals();
    for (const b of [this.data.total, this.data.byDay[day], this.data.byModel[model]]) {
      b.requests++;
      if (success) b.success++; else b.fail++;
      b.promptTokens += u.promptTokens;
      b.completionTokens += u.completionTokens;
      b.reasoningTokens += u.reasoningTokens;
      b.totalTokens += u.totalTokens;
      b.cacheReadTokens += u.cacheReadTokens;
      b.cacheWriteTokens += u.cacheWriteTokens;
    }
    this.data.lastRequest = Date.now();
    this.save();
  }
  /**
   * 节点尝试口径:每次真实发出的上游请求一次。
   * result ∈ success | rateLimited | timeout | upstreamError —— 互斥,只加一个。
   * 不写 lastRequest,那是客户端口径的字段;也不 save,由调用方那次 record 顺手落盘
   * (一次客户端请求最多写一次文件,而不是每换一个节点写一次)。
   * call 是这次尝试实际发出的 { model, effort },记进 lastModel/lastEffort,
   * 成功时还会在 calls 里独立留一条 —— 聚合桶按节点覆盖,同一个节点连着跑
   * 十次不同档位只剩最后一次,而排查强度/模型问题要的正是逐条记录。
   */
  recordAttempt(node, result, usage = null, timing = null, call = null) {
    if (!node) return;
    // 先验参再建桶:名字写错的时候不该在面板上留下一个凭空多出来的节点行
    if (!NODE_OUTCOMES.includes(result)) throw new Error(`未知的节点尝试结果: ${result}`);
    const b = (this.data.byNode[node] ??= blankNode());
    b.requests++;
    b[result]++;
    // 成功失败都算「打过」:一直被限流的节点正是最该排在眼前的那个
    b.lastAt = Date.now();
    if (call) {
      b.lastModel = String(call.model ?? '').trim();
      b.lastEffort = String(call.effort ?? '').trim();
    }
    // timing 只有成功那次会传。ttfb 测不到就不记样本(比如流式开了 200 却一个
    // chunk 都没来),记 0 会把平均值稀释成一个谁都没经历过的数
    if (timing) {
      if (timing.ttfb > 0) { b.ttfbMs += timing.ttfb; b.ttfbCount++; }
      if (timing.total != null) { b.durationMs += timing.total; b.durationCount++; }
    }
    const u = usage ? readUsage(usage) : null;
    if (result === 'success') this.logCall(node, u, timing, call);
    if (!u) return;
    for (const k of ['promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens',
      'cacheReadTokens', 'cacheWriteTokens']) b[k] += u[k];
    if (u.hasCacheData) b.hasCacheData = true;
  }

  /**
   * 成功的调用记一条,超出上限丢最旧的。
   *
   * 只记成功:限流和超时那些在 byNode 的计数里已经有了,而它们没有 token、
   * 没有耗时,逐条列出来只会把真正跑通的请求挤出这 200 条窗口。
   * 不 save —— 和 recordAttempt 一样由调用方那次 record 顺手落盘。
   */
  logCall(node, u, timing, call) {
    // 字段名取短的:这个数组会被整份读写,键名重复 200 遍不是可以忽略的开销
    this.data.calls.push({
      at: Date.now(),
      node,
      model: String(call?.model ?? '').trim(),
      // '' = 没发这个字段,随上游默认 —— 和「发了 high」是两回事
      effort: String(call?.effort ?? '').trim(),
      ttfb: timing?.ttfb > 0 ? timing.ttfb : null,
      ms: timing?.total ?? null,
      in: u?.promptTokens ?? 0,
      out: u?.completionTokens ?? 0,
      reasoning: u?.reasoningTokens ?? 0,
    });
    if (this.data.calls.length > CALL_LOG_LIMIT) {
      this.data.calls.splice(0, this.data.calls.length - CALL_LOG_LIMIT);
    }
  }
  getStats() { return this.data; }
  reset() {
    this.data = this.blank();
    this.save();
    this.logger?.('ok', '[usage] 用量已清零');
  }
}
export class Gateway {
  constructor(cfg, logger) {
    this.config = cfg;          // { apiKey, port, ... },外部改了这里立即生效
    this.logger = logger;
    this.cooldown = new NodeCooldown();
    this.modelCooldown = new ModelCooldown();
    this.usage = new UsageTracker(USAGE_FILE, logger, cfg.persistUsage === true);
    this.agent = new MihomoAgent(MIXED_PORT);
    // 多 lane 并发分摊。冷却表/节点表/affinity/usage 都留在这一个 Gateway 实例上,
    // 子 lane 只多一个独立出站通道(独立 mihomo 进程 + 独立端口),选点/禁用决策
    // 仍查同一份共享状态 —— 主 lane 标记 429/封域,子 lane 立刻一起看不到它。
    this._laneSeq = 0;
    this.lanes = new LaneManager({
      idleMs: LANE_IDLE_MS,
      maxChildren: Number(cfg.maxChildLanes) || MAX_CHILD_LANES,
      createChild: ({ node, nodes, mainNode }) => this._spawnChildLane({ node, nodes, mainNode }),
      destroyChild: (lane) => this._destroyChildLane(lane),
    });
    this.nodeCache = null;
    this.nodeCacheTime = 0;
    this.delay = new Map();     // 节点 -> 实测延迟 ms;null = 测过但不通
    this.testedAt = 0;          // 上次测延迟的时刻,0 = 还没测过
    this.testing = null;        // 进行中的延迟测试 Promise,防并发重复测
    this.lockedNode = null;     // 成功后锁定,后续请求直接用,直到 429
    this.affinity = new NodeAffinity(); // session+model -> node,独立于全局锁
    this.switching = false;
    this.paused = false;        // 重启/重置期间置位,请求收 503 而不是打到坏代理上
    this.models = FREE_MODELS;  // 上游那份免费清单,先用兜底常量顶着
    this.modelsAt = 0;          // 上次拉成功的时刻,0 = 还没拉过
    this.modelsFetch = null;    // 进行中的拉取,防并发(面板 2 秒轮一次)
    this.metadata = new ModelMetadataStore({ file: MODELS_DEV_FILE, logger });
    this.metadataAttemptAt = 0;
    this.metadataFetch = null;
    // 免费模型可用性是独立于能力记录的短请求探针。结果只在内存里留存:
    // 重启后重新确认,避免把旧 IP/旧上游状态当成当前事实。
    this.availability = new ModelAvailability({
      post: (body) => this.forward(body),
      logger,
    });
    this.availabilityFetch = null;
    this.availabilityNextTryAt = 0;

    // 每个模型的上下文上限和思考强度档位。盘上那份 + 内置初值,查不到的开机现探
    // (见 probeCapabilities)。post 直接给 forward:探测要的就是「发一次非流式
    // 请求,成功给我 JSON、失败给我 {status, body}」,而且它不记账 —— 探测的
    // 出站不该出现在面板的调用统计里。
    this.caps = new Capabilities({
      file: CAPS_FILE,
      post: (body) => this.forward(body),
      logger,
    });
    setModelEfforts(this.caps.effortMap());
  }

  /**
   * 给清单里没有记录的模型补一次能力探测,探完把思考强度表灌回 anthropic.mjs。
   *
   * fire-and-forget:调用方(开机流程、拉完清单)都不该等它 —— 一个 1M 模型的
   * 上下文探测要几十秒到几分钟,而在它探完之前网关是**能用**的(那个模型按
   * 「顶档 high + 宽松」处理,也就是有记录之前的老行为)。
   *
   * 全都有记录时这个方法一个字节都不出站,所以正常重启是免费的 —— 只有上游
   * 真上了新模型才会掏钱。
   */
  probeCapabilities(reason = '') {
    return this.caps.probeMissing(this.models)
      .then((r) => {
        if (r.probed?.length) setModelEfforts(this.caps.effortMap());
        return r;
      })
      .catch((e) => {
        this.logger('warn', `[caps] 探测出错${reason ? `(${reason})` : ''}: ${e.message}`);
        return { probed: [], skipped: [], note: 'error' };
      });
  }

  /**
   * 探测当前免费清单的连通性。必须先确认 mihomo 至少有一个节点,
   * 否则 status:0 只代表本地没出站,不能把所有模型误报成不可用。
   * availabilityFetch + 模块内 running 两层去重,分别挡住状态轮询和同一轮内的
   * 重入。force 只给「刚拉到新模型」这类明确事件使用。
   */
  probeAvailability(reason = '', { force = false } = {}) {
    if (this.availabilityFetch) return this.availabilityFetch;
    if (!force && Date.now() < this.availabilityNextTryAt && !this.availability.running) {
      return Promise.resolve(this.availability.status(this.models));
    }
    this.availabilityNextTryAt = Date.now() + MODEL_AVAILABILITY_RETRY_MS;
    this.availabilityFetch = (async () => {
      const nodes = await this.getAllNodes();
      if (!nodes.length) {
        this.logger('info', `[availability] 无可用节点,跳过探测${reason ? `(${reason})` : ''}`);
        return this.availability.status(this.models);
      }
      return this.availability.probe(this.models);
    })()
      .catch((e) => {
        this.logger('info', `[availability] 探测失败${reason ? `(${reason})` : ''}: ${e?.message || e}`);
        return this.availability.status(this.models);
      })
      .finally(() => { this.availabilityFetch = null; });
    return this.availabilityFetch;
  }

  /** 面板要的模型可用性表;到期探测放后台,绝不阻塞 /api/status。 */
  modelAvailability() {
    const models = this.freeModels();
    if (this.availability.needsProbe(models) && !this.availability.running) {
      this.probeAvailability('状态').catch(() => {});
    }
    return this.availability.status(models);
  }

  /** 开机/节点就绪后启动每六小时一轮的后台探测。 */
  startAvailabilityScheduler() {
    this.availability.startScheduler(
      () => this.freeModels(),
      {
        canProbe: async () => (await this.getAllNodes()).length > 0,
        // 启动即计算当前记录的到期时间;稳定结果仍睡六小时,
        // 没节点时才按短间隔检查节点是否恢复。
        immediate: true,
      },
    );
    return this.availability.schedulerStatus();
  }

  stopAvailabilityScheduler() {
    this.availability.stopScheduler();
  }

  modelAvailabilityStatus() {
    return this.availability.schedulerStatus();
  }

  /** 面板要的那张「id → 上下文上限」,只给当前清单里的 —— 下线的模型不该显示 */
  modelCtx() {
    return this.caps.ctxMap(this.models);
  }

  modelMetadata(model) {
    return this.metadata.get(model);
  }

  modelMetadataMap() {
    return this.metadata.forModels(this.models);
  }

  modelMetadataStatus() {
    const status = this.metadata.status();
    // Keep status polling cheap and throttle failed refreshes to one attempt per TTL.
    if (status.stale && Date.now() - this.metadataAttemptAt >= MODELS_DEV_TTL_MS) {
      this.refreshModelMetadata().catch(() => {});
    }
    return status;
  }

  refreshModelMetadata({ force = false } = {}) {
    if (this.metadataFetch) return this.metadataFetch;
    if (!force && Date.now() - this.metadataAttemptAt < MODELS_DEV_TTL_MS) {
      return Promise.resolve({ updated: false, reason: 'attempted', models: this.metadata.status().models });
    }
    this.metadataAttemptAt = Date.now();
    this.metadataFetch = this.metadata.refresh({ force })
      .finally(() => { this.metadataFetch = null; });
    return this.metadataFetch;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /** 手动重置:清冷却 + 解锁 + 弃节点缓存(订阅换了以后旧节点名已经不存在了) */
  resetCooldowns() {
    const n = this.cooldown.clearAll();
    const m = this.modelCooldown.clearAll();
    this.lockedNode = null;
    this.affinity.clear();
    this.nodeCache = null;
    this.nodeCacheTime = 0;
    this.logger('ok', `[reset] 清空 ${n} 个节点冷却和 ${m} 个模型冷却记录,重置锁定节点`);
    return n + m;
  }

  // ── /v1/* 路由 ────────────────────────────────────────

  /**
   * 两种鉴权头都认。
   *
   * OpenAI 客户端发 `Authorization: Bearer <key>`,Anthropic 客户端发
   * `x-api-key: <key>` —— 只认前者的话 /v1/messages 对每个真实 Anthropic
   * 客户端都是 401,而客户端往往把 401 翻译成「模型不存在或你没有权限」,
   * 于是排查方向被带跑偏。这是实测踩过的坑,别再收窄。
   */
  checkKey(req) {
    const want = this.config.apiKey;
    if (!want) return false;
    const xk = req.headers['x-api-key'];
    if (typeof xk === 'string' && xk && safeEqual(xk, want)) return true;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
    return !!m && safeEqual(m[1], want);
  }

  handleModels(res) {
    const models = this.freeModels();
    const metadata = this.metadata.forModels(models);
    const ctx = this.modelCtx();
    json(res, {
      object: 'list',
      data: models.map((id) => {
        const meta = metadata[id];
        const base = { id, object: 'model', created: 1700000000, owned_by: 'opencode-zen' };
        if (!meta) return base;
        return {
          ...base,
          name: meta.name,
          ...(meta.description ? { description: meta.description } : {}),
          // models.dev context values are advisory and known to be wrong for some
          // Zen models; expose the locally probed capability instead.
          ...(ctx[id] != null ? { context_window: ctx[id] } : {}),
          ...(meta.maxOutputTokens != null ? { max_output_tokens: meta.maxOutputTokens } : {}),
          ...(meta.inputCost != null ? { input_cost: meta.inputCost } : {}),
          ...(meta.outputCost != null ? { output_cost: meta.outputCost } : {}),
          ...(meta.cacheReadCost != null ? { cache_read_cost: meta.cacheReadCost } : {}),
          ...(meta.cacheWriteCost != null ? { cache_write_cost: meta.cacheWriteCost } : {}),
          input_modalities: meta.inputModalities,
          output_modalities: meta.outputModalities,
          reasoning: meta.reasoning,
          tool_call: meta.toolCall,
          deprecated: meta.deprecated,
          native_protocol: meta.nativeProtocol,
        };
      }),
    });
  }

  /**
   * 当前的免费模型清单。**同步返回缓存**,过期了顺手在后台拉一次。
   *
   * 面板每 2 秒轮一次 /api/status,清单搭这趟车走 —— 所以这里绝不能 await
   * 一个出站请求:那会让整个面板的刷新跟着上游的 RTT 走,节点慢的时候一眼
   * 就看出来卡。第一次调用返回的是兜底常量,拉到了下一次轮询就换成真的。
   */
  freeModels() {
    if (Date.now() - this.modelsAt > MODELS_TTL_MS) {
      this.refreshModels().catch(() => {});   // 失败不影响调用方,详情在 refreshModels 里记日志
    }
    return this.models;
  }

  /**
   * 去上游拉一次免费清单。并发调用共用同一个 Promise。
   *
   * 先直连,不通再走代理。这个端点是个公开目录,不鉴权也不按 IP 算额度
   * (那是 completions 的事),所以直连没有坏处,还省一次经节点的出站 ——
   * 而且内核没起来时(没配订阅、或 mihomo 挂了)直连是唯一能拉到的路。
   * 两条都不通就继续用上一份,冷启动时那就是 FREE_MODELS。
   */
  refreshModels() {
    if (this.modelsFetch) return this.modelsFetch;
    this.modelsFetch = this.upstreamGet(MODELS_PATH, 8_000, null)
      .catch((e) => {
        this.logger('info', `[models] 直连拉清单失败(${e.message}),改走代理`);
        return this.upstreamGet(MODELS_PATH);
      })
      .then((d) => {
        const free = pickFreeModels((d?.data || []).map((m) => m?.id));
        // 空结果不接受:上游改了形状或返回了个错误页时,旧清单比空列表有用
        if (!free.length) throw new Error('返回里没有免费模型');
        const added = free.filter((m) => !this.models.includes(m));
        const gone = this.models.filter((m) => !free.includes(m));
        this.models = free;
        this.modelsAt = Date.now();
        for (const model of gone) {
          this.modelCooldown.clear(model);
          this.availability.expire(model);
        }
        if (added.length) this.logger('info', `[models] 免费清单 ${free.length} 个,新增 ${added.join(', ')}`);
        if (gone.length) this.logger('info', `[models] 免费清单 ${free.length} 个,下线 ${gone.join(', ')}`);
        // 新上的模型现探一次,别等下次重启。下线的**不删记录** —— 它哪天回来了
        // id 一样就直接复用,而面板显示的是这份清单,记录里多几条没人问它。
        if (added.length) {
          this.probeCapabilities('新模型');
          this.probeAvailability('新模型', { force: true }).catch(() => {});
        }
        return { models: free, added, gone };
      })
      .catch((e) => {
        // 拉不到不改 models,继续用上一份。这里**往外抛** —— 「同步模型」按钮
        // 要能把失败报给用户,而自动那条路(freeModels / 开机)自己 catch 掉。
        // 但 modelsAt 照样推进:否则面板每 2 秒轮一次就会每 2 秒重试一次出站。
        this.modelsAt = Date.now();
        this.logger('warn', `[models] 拉免费清单失败(${e.message}),继续用上一份 ${this.models.length} 个`);
        throw e;
      })
      .finally(() => { this.modelsFetch = null; });
    return this.modelsFetch;
  }

  /**
   * GET 上游的公开端点。目前只有模型清单用它,所以不做成通用客户端 ——
   * 和 forward 一样不带 Authorization,那个端点不要鉴权。
   *
   * agent 传 null 就是直连(绕开 mihomo),默认经节点走。
   */
  upstreamGet(path, timeout = 8_000, agent = this.agent) {
    return new Promise((resolve, reject) => {
      const r = https.request({
        host: OPENCODE_HOST, port: 443, path, method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'node' },
        // 传 null/undefined 时 Node 用 globalAgent,也就是不经隧道的直连
        agent: agent || undefined,
        timeout,
      }, (resp) => {
        let data = '';
        resp.on('data', (c) => (data += c));
        resp.on('end', () => {
          if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
          try { resolve(JSON.parse(data)); } catch { reject(new Error('返回不是 JSON')); }
        });
      });
      r.on('error', (e) => reject(e));
      r.on('timeout', () => { r.destroy(); reject(new Error(`timeout after ${timeout}ms`)); });
      r.end();
    });
  }

  /**
   * POST /v1/messages/count_tokens。
   *
   * Claude Code / Cline 在正式请求前会先问一次「这些消息多少 token」。上游没有
   * 这个能力,而缺这个路由客户端会直接报错退出 —— 所以本地估一个:按字符数
   * 除以 3.5(混合中英文时比英文经验值 4 更接近)。
   *
   * 这个数只用于客户端自己决定要不要压缩上下文,不参与计费、不影响转发结果,
   * 估偏一点没有后果;拿不到数导致客户端起不来才是真问题。
   */
  async handleCountTokens(req, res) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8e6) return ANTHROPIC.fail(res, 413, 'Request too large', 'request_too_large');
    }
    let body;
    try { body = JSON.parse(raw); } catch { return ANTHROPIC.fail(res, 400, 'Invalid JSON', 'invalid_request_error'); }

    let chars = flattenText(body.system).length;
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
      chars += flattenText(m?.content).length;
      // 工具调用的参数也是 token,不算会低估很多
      for (const b of Array.isArray(m?.content) ? m.content : []) {
        if (b?.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length;
      }
    }
    for (const t of Array.isArray(body.tools) ? body.tools : []) {
      chars += JSON.stringify(t?.input_schema ?? {}).length + String(t?.description ?? '').length;
    }
    return json(res, { input_tokens: Math.max(1, Math.ceil(chars / 3.5)) });
  }

  async handleChat(req, res, dialect = OPENAI) {
    const reqStart = Date.now();
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8e6) return dialect.fail(res, 413, 'Request too large', 'request_too_large');
    }
    // 预算按体积算,但从请求进来的那一刻起算 —— 几 MB 的上传本身就要几秒到几十秒,
    // 等收完才起算等于白送一段,而客户端是从发出请求就开始等的
    const deadline = reqStart + budgetFor(raw.length);
    let inbound;
    try { inbound = JSON.parse(raw); } catch { return dialect.fail(res, 400, 'Invalid JSON', 'invalid_request_error'); }

    const bad = dialect.validate(inbound);
    if (bad) return dialect.fail(res, 400, bad, 'invalid_request_error');

    // 流式意图在两种方言里都是顶层 stream:true,转换后依然如此
    const wantStream = inbound.stream === true;
    const body = dialect.toUpstream(inbound);

    // 严格透传:客户端点哪个模型就发哪个,但只放行实时免费清单里的。
    // 以前这里无条件改写成一个固定模型 —— 客户端于是拿到的是另一个模型的回答,
    // 而它完全不知道被换过。宁可 400 说清楚,也不静默给个别的。
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) return dialect.fail(res, 400, 'model is required', 'invalid_request_error');
    const free = this.freeModels();
    if (!free.includes(model)) {
      // 不回显清单:那是 /v1/models 的活,错误体里塞几十个模型名没人读
      return dialect.fail(res, 400,
        `Model not available: ${model} —— 只接受 /v1/models 里的免费模型`, 'invalid_model');
    }
    const unavailable = this.modelCooldown.get(model);
    if (unavailable) {
      return dialect.fail(res, 400,
        `Model unavailable: ${model} —— 上游暂不可用,约 ${unavailable.remain}s 后重试`,
        'invalid_model', { cooldown: [{ model, remain: unavailable.remain }] });
    }
    body.model = model;

    /**
     * 思考强度。reasoningEffort 从客户端的四种写法(reasoning_effort /
     * reasoning.effort / output_config.effort / thinking.budget_tokens)统一转成
     * 这个模型认的档位或 ''。
     *
     * 空值不发字段 —— 随上游自己的默认(DS4F 是 high);有值就覆盖掉 body 里
     * 原有的,这样带着的乱值(客户端写了个 foo)和会被上游丢掉的顶档别名
     * (xhigh)都在这儿收敛掉。往哪个字段塞由方言定:chat/messages 是顶层
     * reasoning_effort,Responses 是嵌套 reasoning.effort —— 塞错字段上游会忽略,
     * 于是「客户端设了 max 却没生效」。
     *
     * 必须放在 body.model 定案之后:顶档叫 max 还是 high 取决于模型。
     */
    const effort = reasoningEffort(inbound, model);
    dialect.applyEffort(body, effort);

    // session 同时服务稳定上游标识和节点 affinity。完整 OpenCode 请求头开关
    // 关着时只发 x-opencode-session,其余头不发。
    const requestIdentity = identityHeaders({ headers: req.headers, body: inbound });
    // 稳定 session 是独立能力:即使完整 OpenCode 头开关关闭,也把会话标识发给
    // 上游,让同一对话有机会命中 prompt cache。其余 client/project/user-agent
    // 仍遵守原有实验开关,避免无意改变免费端点的请求画像。
    const identity = this.config.opencodeIdentityHeaders
      ? requestIdentity
      : { 'x-opencode-session': requestIdentity['x-opencode-session'] };
    const affinityKey = this.affinity.key(requestIdentity['x-opencode-session'], model);

    // 排过序的表:延迟低的在前,测不通的直接不在表里。pickAvailable 取的是
    // 「第一个不冷却的」,所以排序在这儿就等于优先级。
    const nodes = this.rankNodes(await this.getAllNodes());
    if (nodes.length === 0) {
      return dialect.fail(res, 503, '没有可用节点 —— 检查订阅地址和 mihomo 状态', 'no_nodes');
    }
    // 并发分摊:主 lane 忙时(已有请求占用)尝试开子 lane,让它走独立出口 IP。
    // 子 lane 只在有独立可用节点时才创建;没有就回落主 lane,绝不丢请求。
    // 注意:子 lane 只出现在主 lane 已被占用的时刻,所以平时(单用户、低并发)
    // 行为与现状完全一致 —— 一个节点用到底,只有并发挤压时才启用第二条线。
    let lane = null;
    try {
      lane = await this.acquireLane({
        nodes,
        mainNode: this.lockedNode,
        available: (node) => !this.cooldown.isCooling(node, providerGroup(model)),
      });
    } catch (e) {
      this.logger('warn', `[lane] 分配失败,回落主 lane: ${e.message}`);
    }

    const cur = await this.ensureNode(nodes, res, dialect, deadline, model, affinityKey, lane);
    if (!cur) {
      // ensureNode 可能在选点前就回错误(例如全员 5xx 冷却);这次请求已经
      // acquire 过 lane,必须在提前返回前归还,否则连续失败会把 active 越堆越高。
      if (lane) this.lanes.release(lane);
      return;
    }
    // 子 lane 绑定节点被冷却时 ensureNode 内部回退了,返回的 cur 是主 lane 选的。
    // 此时 lane 已失去意义(它固定绑在冷却节点上),释放它、改走主 lane。
    if (lane && lane.node !== cur) {
      this.lanes.release(lane);
      lane = null;
    }
    return this.attempt(res, body, nodes, cur, wantStream, dialect, deadline, identity, effort, affinityKey, lane);
  }

  /** Anthropic Messages API 入口。同一条路,只是换个方言。 */
  async handleMessages(req, res) {
    return this.handleChat(req, res, ANTHROPIC);
  }

  /** OpenAI Responses API 入口。上游原生支持,同一条路换个方言(近乎透传)。 */
  async handleResponses(req, res) {
    return this.handleChat(req, res, RESPONSES);
  }

  /** 选定本次要用的节点并让 mihomo 切过去;返回节点名,失败返回 null(已响应) */
  async ensureNode(nodes, res, dialect = OPENAI, deadline = Infinity, model = null, affinityKey = '', lane = null) {
    const group = providerGroup(model);
    // 子 lane 已经在拉起时固定绑了节点:直接用它,不再经主 selector 挑选/切换。
    // 它选节点时用的就是这份共享冷却表,所以这里只需要再确认没被并发冷却掉。
    if (lane && lane.node) {
      if (!this.cooldown.isCooling(lane.node, group)) {
        if (affinityKey) this.affinity.bind(affinityKey, lane.node);
        return lane.node;
      }
      // 绑定节点已被冷却:释放 affinity,回退主 lane 的常规路径(主 lane 会另选)
      if (affinityKey) this.affinity.release(affinityKey, lane.node);
      lane = null;
    }
    let cur = affinityKey
      ? this.affinity.pick(affinityKey, nodes, {
        preferred: this.lockedNode,
        available: (node) => !this.cooldown.isCooling(node, group),
      })
      : this.lockedNode;
    if (affinityKey && cur && nodes.includes(cur)) {
      if ((await this.getCurrentNode()) === cur || await this.switchNode(cur)) return cur;
      this.affinity.release(affinityKey, cur);
      this.cooldown.mark429(cur, group);
      dialect.fail(res, 503, 'Switch node failed', 'api_error');
      return null;
    }
    if (!affinityKey && cur && !this.cooldown.isCooling(cur, group) && nodes.includes(cur)) return cur;

    cur = this.cooldown.pickAvailable(nodes, group);
    if (!cur) {
      // 5xx/封域冷却不是用户限流:不能按 429 等待 60s,也不能把它伪报成
      // all_nodes_429。此时入口直接回 503,让调用方按自己的策略重试。
      const cooling = nodes
        .map((node) => this.cooldown.get(node, group))
        .filter(Boolean);
      const allUpstreamFailure = cooling.length === nodes.length && cooling.every((c) =>
        c.reason === '5xx' || c.blocked === true);
      if (allUpstreamFailure) {
        this.logger('warn', `[cooldown] 所有节点都因上游 5xx/封域不可用,不等待 429 冷却`);
        dialect.fail(res, 503, 'No usable upstream node', 'all_nodes_unavailable');
        return null;
      }
      // 全员冷却:等剩余最短的那个恢复,而不是直接失败
      const s = this.cooldown.soonest(nodes, group);
      if (s && s.remain > 0) {
        // 但不能等过预算。挂到客户端自己超时的话,它显示的是自己的兜底文案
        // (「模型不存在」那种),真实原因一个字都传不到 —— 宁可立刻回 429,
        // 把「还要等多久」明确写给它。
        if (Date.now() + s.remain + 1000 > deadline) {
          this.logger('warn', `[cooldown] 全员冷却且等不到预算内,直接回 429(剩 ${Math.ceil(s.remain / 1000)}s)`);
          dialect.fail(res, 429, 'All nodes rate-limited', 'all_nodes_429', { cooldown: this.cooldown.summary() });
          return null;
        }
        this.logger('warn', `[cooldown] 所有节点冷却中,等 ${s.node} 恢复(剩 ${Math.ceil(s.remain / 1000)}s)`);
        await sleep(s.remain + 1000);
        cur = s.node;
        this.cooldown.clear(cur, group);
      } else {
        cur = nodes[0];
      }
    }
    if ((await this.getCurrentNode()) !== cur && !(await this.switchNode(cur))) {
      this.cooldown.mark429(cur, group);
      dialect.fail(res, 503, 'Switch node failed', 'api_error');
      return null;
    }
    if (affinityKey) this.affinity.bind(affinityKey, cur);
    return cur;
  }
  /**
   * 重试循环:429 换节点,网络错误只重试当前节点(换了也是白换,避免振荡)。
   *
   * 两套账在这里分叉,别混:
   *   this.usage.recordAttempt(cur, ...) 每次真实发出的上游请求都记一次
   *   this.usage.record(model, ...)      整个客户端请求只记一次,在终态记
   * 所以下面每条 `continue`(还要再试)之前只有 recordAttempt,
   * 每条 `return`(定案了)才有 record。
   */
  async attempt(res, body, nodes, cur, wantStream, dialect = OPENAI, deadline = Infinity,
    identity = null, effort = '', affinityKey = '', lane = null) {
    const tried = new Set();
    const MAX_NET_RETRY = 2;
    let netRetry = 0;
    let switches = 0;
    // 连续 5xx 秒拒计数:连续 3 个节点都被上游 5xx 拒就停(见 retryable 分支),
    // 不在这批坏出口里空转。任何非 5xx 分支(成功、429、超时、其它 4xx)都重置。
    let consecutive5xx = 0;
    const left = () => deadline - Date.now();
    const call = { model: body.model, effort };
    const fails = { timeout: 0, rateLimited: 0 };
    const bind = (node) => { if (affinityKey) this.affinity.bind(affinityKey, node); };
    const unbind = (node) => { if (affinityKey) this.affinity.release(affinityKey, node); };
    // 子 lane 的 selector 在它自己的 mihomo 进程里,切节点只能走它的控制端口;
    // 主 lane 才动全局 selector。cooling 状态永远共享同一份,不影响。
    // 节点名以子 lane 自己的表为准:名字在它表里就直切,不在(机场刚换节点、
    // 主 lane 名字过期)就退到它表里第一个,保证切得动、不撞 proxy not exist。
    const resolveChildName = (node) => (lane && lane.nodes && lane.nodes.includes(node))
      ? node
      : (lane && lane.nodes && lane.nodes.length ? lane.nodes[0] : node);
    const doSwitch = (node) => lane
      ? this._childSwitch(lane.inst, resolveChildName(node))
      : this.switchNode(node);
    const switchTo = async (node) => {
      const target = lane ? resolveChildName(node) : node;
      if (!(await doSwitch(node))) {
        unbind(node);
        return false;
      }
      cur = target;   // 子 lane 可能落到它自己的第一个节点,记录实际名字而非请求名
      bind(cur);
      return true;
    };
    const pickNext = (group, exclude) => affinityKey
      ? this.affinity.pick(affinityKey, nodes, {
        exclude,
        preferred: this.lockedNode,   // 迁移也优先粘全局当前节点(单节点优先)
        available: (node) => !this.cooldown.isCooling(node, group),
      })
      : this.cooldown.pickAvailable(nodes, group, exclude);
    // 终态统一释放 lane。成功/失败都会走到,子 lane 由此空闲计数归零、可被回收。
    const finishLane = () => { if (lane) this.lanes.release(lane); };

    /**
     * 终态失败的统一出口。原来三处各写一套文案,其中「Tried N nodes, all
     * unavailable」根本不看原因 —— 大上下文 prefill 慢也被说成节点坏。实测 256K
     * 的请求就会触发它,而那批节点是好的,拿着这句话去查节点是白费功夫。
     *
     * 现在说法由实际计数决定:有超时就报超时,并把体积带上(体积大到几 MiB 时
     * 「慢」几乎总是真原因);真的一个节点都切不动,才叫 all_nodes_unavailable。
     * forceTimeout 给「预算烧穿」用 —— 那本身就是超时,和试了几次无关。
     */
    const giveUp = (note, forceTimeout = false) => {
      finishLane();
      this.usage.record(body.model, null, false);
      // 只在失败路径上序列化:成功路径不该为一句错误文案付几 MiB 的代价
      const mib = JSON.stringify(body).length / 1048576;
      this.logger('error',
        `[chat] ${note}(超时 ${fails.timeout} 次 / 限流 ${fails.rateLimited} 次,体积 ${mib.toFixed(1)} MiB)`);
      if (forceTimeout || fails.timeout) {
        const hint = mib >= 1
          ? ` (request is ${mib.toFixed(1)} MiB — large-context prefill is slow, not a node fault)` : '';
        return dialect.fail(res, 504, `Upstream timed out after ${fails.timeout} attempt(s)${hint}`, 'timeout');
      }
      if (fails.rateLimited) {
        return dialect.fail(res, 429, 'All nodes rate-limited', 'all_nodes_429', { cooldown: this.cooldown.summary() });
      }
      return dialect.fail(res, 503, 'No usable upstream node', 'all_nodes_unavailable');
    };

    const returnUpstreamError = (e, attemptRecorded = false) => {
      finishLane();
      const status = Number(e?.status) || 502;
      if (!attemptRecorded) this.usage.recordAttempt(cur, 'upstreamError', null, null, call);
      this.usage.record(body.model, null, false);
      this.logger('error', `[chat] HTTP ${status}: ${String(e?.body ?? e?.message ?? '').slice(0, 300)}`);
      if (dialect === OPENAI || dialect === RESPONSES) {
        let payload;
        try { payload = JSON.parse(e?.body); } catch { payload = { error: { message: `HTTP ${status}` } }; }
        return json(res, payload, status);
      }
      return dialect.fail(res, status, upstreamErrorMessage(e?.body) || `HTTP ${status}`, errTypeFor(status));
    };

    // 次数和时间两个上限,谁先到都停。次数防「48 个节点挨个试」,
    // 时间防「每次都慢但都没超时」—— 只有次数上限的话后者能拖到几十分钟。
    while (switches <= MAX_NODE_TRIES) {
      if (left() < MIN_TRY_MS) {
        // 一个字节都还没发出去,所以只记客户端那一笔,不记节点尝试
        return giveUp(`预算烧穿,放弃(换过 ${switches} 个节点)`, true);
      }
      const t0 = Date.now();
      try {
        const result = wantStream
          ? await this.forwardStream(res, body, dialect, left(), identity, lane?.agent)
          : await this.forward(body, left(), identity, dialect.path, lane?.agent);

        const dt = Date.now() - t0;
        if (wantStream) {
          // 流式在 forwardStream 里边转发边攒 usage,这儿只拿到结果汇总。
          // ok:false = 首字节之后断的 —— 响应已经发出去一半,重试不了,
          // 但这次尝试对节点来说是上游错误,对客户端来说是一次失败。
          if (result.ok) {
            // 子 lane 不更新全局 lockedNode:并发子请求不该把主 lane 的粘滞顶掉
            if (!lane) {
              this.lockedNode = cur;
              this.saveLastNode(cur);
            }
            this.cooldown.clear(cur);
            consecutive5xx = 0;
            bind(cur);
          } else {
            unbind(cur);
          }
          // 只给成功那次记耗时:中断的那次总耗时量的是「断在第几秒」,
          // 不是这个节点跑完一次要多久,混进平均值里读不出任何东西
          this.usage.recordAttempt(cur, result.ok ? 'success' : 'upstreamError', result.usage,
            result.ok ? { ttfb: result.ttfb, total: dt } : null, call);
          this.usage.record(body.model, result.usage, result.ok);
          this.logger(result.ok ? 'ok' : 'error',
            `[stream-${result.ok ? 'ok' : 'cut'}] node="${cur}"${lane ? ` lane=${lane.id}` : ''} ${dt}ms effort=${effort || '默认'}`);
          finishLane();
          return;
        }
        if (!lane) {
          this.lockedNode = cur;
          this.saveLastNode(cur);
        }
        this.cooldown.clear(cur);
        consecutive5xx = 0;
        bind(cur);
        this.usage.recordAttempt(cur, 'success', result.usage, { ttfb: result._ttfb, total: dt }, call);
        this.usage.record(body.model, result.usage, true);
        this.logger('ok', `[ok] node="${cur}"${lane ? ` lane=${lane.id}` : ''} ${dt}ms tokens=${result.usage?.total_tokens ?? '?'}`
          + ` effort=${effort || '默认'}`);
        finishLane();
        return dialect.respond(res, result, body.model);
      } catch (e) {
        const status = e.status || 0;

        // 流已经开始吐了就不能重试:头都发出去了,换节点等于给客户端拼接两半响应。
        // 收尾由 forwardStream 里的 sink 负责(它才拿得到那个 sink),这里只记账。
        if (e.notStarted === false) {
          unbind(cur);
          this.usage.recordAttempt(cur, 'upstreamError', null, null, call);
          this.usage.record(body.model, null, false);
          this.logger('error', `[stream-mid] node="${cur}" 中断: ${e.body || e.message}`);
          try { res.end(); } catch {}
          finishLane();
          return;
        }

        if (status === 429) {
          const group = providerGroup(body.model);
          const retryAfter = e.retryAfter ?? null;
          this.cooldown.mark429(cur, group, retryAfter);
          unbind(cur);
          this.usage.recordAttempt(cur, 'rateLimited', null, null, call);
          fails.rateLimited++;
          const coolSec = retryAfter ?? Math.ceil(COOLDOWN_MS / 1000);
          this.logger('warn', `[429] node="${cur}" model="${body.model}" group="${group}" 限流,冷却 ${coolSec}s${retryAfter ? ' (Retry-After)' : ''}`);
          tried.add(cur);
          netRetry = 0;
          consecutive5xx = 0;

          const next = pickNext(group, tried);
          if (!next) {
            const s = this.cooldown.summary();
            this.usage.record(body.model, null, false);
            this.logger('error', `[chat] 全部节点冷却中: ${s.length} 个`);
            finishLane();
            return dialect.fail(res, 429,
              `All nodes rate-limited, retry in ~${s[0]?.remain || Math.ceil(COOLDOWN_MS / 1000)}s`, 'all_nodes_429', { cooldown: s });
          }
          // 换之前喘 2 秒:重置后一口气把所有节点扫成 429 就是这么来的,
          // 上游限流是按窗口算的,给它一点恢复时间
          await sleep(2000);
          switches++;
          if (await switchTo(next)) cur = next;
          else {
            tried.add(next);
            const fallback = pickNext(group, tried);
            if (!fallback) {
              return giveUp('切不动节点了(候选全试过或全在冷却)');
            }
            switches++;
            if (await switchTo(fallback)) cur = fallback;
            else {
              tried.add(fallback);
              continue;
            }
          }
          continue;
        }

        if (status === 0) {
          // 超时/连接失败:每次都是真发出去过的一次尝试,所以重试前先记一笔
          this.usage.recordAttempt(cur, 'timeout', null, null, call);
          fails.timeout++;

          // 机场拒连(TLS 握手断/证书劫持/SNI 封锁)是确定性故障:
          // 重试同一节点只会把每次请求拖长几十秒(卡死事故的根因),直接进
          // 封域冷却并立刻换下一个。
          if (isNodeBlockedError(e)) {
            const group = providerGroup(body.model);
            this.cooldown.markBlocked(cur, group);
            tried.add(cur);
            netRetry = 0;
            consecutive5xx = 0;
            this.logger('warn', `[blocked] node="${cur}" 疑似机场拒连该域名(${String(e.body || e.message).slice(0, 80)}),冷却 ${BLOCKED_COOLDOWN_MS / 60_000}min,立即换下一个`);
            unbind(cur);
            if (this.lockedNode === cur) this.lockedNode = null;
            const next = pickNext(group, tried);
            if (!next) return giveUp('所有节点都被机场拒连或冷却中');
            switches++;
            if (await switchTo(next)) cur = next;
            else {
              tried.add(next);
              continue;
            }
            continue;
          }

          if (++netRetry <= MAX_NET_RETRY) {
            this.logger('warn', `[net-retry ${netRetry}/${MAX_NET_RETRY}] node="${cur}": ${e.body || e.message}`);
            await sleep(1000);
            continue;
          }
          tried.add(cur);
          netRetry = 0;
          consecutive5xx = 0;
          this.logger('warn', `[timeout] node="${cur}" 重试 ${MAX_NET_RETRY} 次仍失败,换下一个`);
          unbind(cur);
          const group = providerGroup(body.model);
          const next = pickNext(group, tried);
          if (!next) {
            return giveUp('所有节点都超时,没有可换的了', true);
          }
          switches++;
          if (await switchTo(next)) cur = next;
          else {
            tried.add(next);
            const fallback = pickNext(group, tried);
            if (!fallback) {
              return giveUp('切不动节点了(候选全试过或全在冷却)');
            }
            switches++;
            if (await switchTo(fallback)) cur = fallback;
            else {
              tried.add(fallback);
              continue;
            }
          }
          continue;
        }

        const kind = classifyUpstreamError(status, e.body);
        if (kind === 'model_unavailable') {
          this.modelCooldown.mark(body.model, upstreamErrorMessage(e.body));
          this.availability.markUnavailable(body.model, e);
          return returnUpstreamError(e);
        }

        if (kind === 'retryable') {
          this.usage.recordAttempt(cur, 'upstreamError', null, null, call);
          // 5xx 秒拒是坏出口的确定性特征:记一笔短冷却,让这一整批被上游爆满
          // 拒掉的节点一段时间内排到队尾,而不是每来一个请求都优先挑到延迟
          // 最低的这批(它们延迟最低,专挑坏的打)。
          const group = providerGroup(body.model);
          const is5xx = status >= 500 && status < 600;
          if (is5xx) this.cooldown.mark5xx(cur, group);
          tried.add(cur);
          netRetry = 0;
          if (this.lockedNode === cur) this.lockedNode = null;
          unbind(cur);
          // 连续 3 个节点都 5xx 秒拒,说明整批出口都被上游爆满拒掉,再空转也是
          // 同样结果,直接把上游的 5xx 原样带给客户端,让调用方自己决定重试。
          if (is5xx && ++consecutive5xx >= 3) {
            this.logger('warn', `[5xx] 连续 ${consecutive5xx} 个节点被上游 5xx 秒拒,停止换节点,原样回上游错误`);
            return returnUpstreamError(e, true);
          }
          if (!is5xx) consecutive5xx = 0;
          let moved = false;
          while (!moved) {
            const next = pickNext(group, tried);
            if (!next) break;
            switches++;
            if (await switchTo(next)) {
              moved = true;
              break;
            }
            tried.add(next);
            if (switches > MAX_NODE_TRIES) break;
          }
          if (moved) continue;
          return returnUpstreamError(e, true);
        }

        // 其它 4xx:换节点也是同样结果,直接把上游的话原样带回去。
        // OpenAI 和 Responses 的错误体本来就是 {error:{...}} 同形,原样透传;
        // 只有 Anthropic 客户端读不懂,得摘成 message 塞进它那套壳里。
        return returnUpstreamError(e);
      }
    }
    return giveUp(`换过 ${MAX_NODE_TRIES} 个节点仍未成功`);
  }
  // ── 出站 ──────────────────────────────────────────────

  /**
   * 两个 forward 共用的请求选项。
   *
   * 不带 Authorization + User-Agent: node 是刻意的 —— zen 免费端点就认这个形态,
   * 补上 Bearer 反而 401。额度按出口 IP 算,所以换 IP 才是有意义的动作。
   *
   * identity 非空时补上稳定 session;完整 identity 对象(实验开关开着)还会覆盖
   * User-Agent 并补上 OpenCode 那组头。Authorization 始终不加入。
   */
  reqOpts(bodyStr, { accept, timeout, identity = null, path = CHAT_PATH, agent = this.agent }) {
    return {
      host: OPENCODE_HOST,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        'User-Agent': 'node',
        ...identity,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      agent,     // ← 真正经 mihomo 出站的地方(子 lane 传自己的 agent,走独立出口)
      timeout,
    };
  }

  forward(body, budget = Infinity, identity = null, path = CHAT_PATH, agent = this.agent) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify({ ...body, stream: false });
      // 单次超时不能超过整体剩余预算,否则一次慢请求就把预算吃穿
      const timeout = Math.max(1_000, Math.min(silentFor(bodyStr.length), budget));
      const t0 = Date.now();
      const r = https.request(this.reqOpts(bodyStr, { accept: '*/*', timeout, identity, path, agent }), (resp) => {
        let data = '';
        // 非流式的「首字」= 上游开始回话的时刻。整个 body 是一次攒完的,
        // 所以它和总耗时差的就是传输那点时间,不像流式那样能差几十秒
        let ttfb = 0;
        resp.on('data', (c) => { ttfb ||= Date.now() - t0; data += c; });
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            const retryAfter = parseRetryAfter(resp.headers['retry-after']);
            return reject({ status: resp.statusCode, body: data, retryAfter });
          }
          try {
            // 不可枚举:这个对象会被 OPENAI.respond 原样 JSON.stringify 给客户端,
            // 普通属性会当成上游字段泄出去
            resolve(Object.defineProperty(JSON.parse(data), '_ttfb', { value: ttfb }));
          } catch { reject({ status: 502, body: data }); }
        });
      });
      r.on('error', (e) => reject({ status: 0, body: e.message }));
      r.on('timeout', () => { r.destroy(); reject({ status: 0, body: `timeout after ${timeout}ms` }); });
      r.end(bodyStr);
    });
  }

  /**
   * 流式转发。上游的 SSE 交给 dialect.sink 决定怎么落地:
   * OpenAI 原样透传,Anthropic 翻译成 Messages 事件。
   *
   * 两段超时刻意分开:等第一个字节要短(还能重试),开始吐了以后要长
   * (推理模型思考几十秒很正常,这时候掐掉等于毁掉一个已经成功的请求)。
   *
   * 首字节发出去之后就不再 reject,而是 resolve 成 { ok, usage } —— 记账
   * 交给 attempt 一处做,不然「按节点分类」这件事得在两个文件里各写一遍。
   */
  forwardStream(res, body, dialect = OPENAI, budget = Infinity, identity = null, agent = this.agent) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify({ ...body, stream: true });
      const ttfb = Math.max(1_000, Math.min(silentFor(bodyStr.length), budget));

      // 头一旦发出去,这个请求就不能重试了 —— 换节点重发等于把两半响应拼给
      // 客户端。所以所有失败路径都得先看这个标志:started 之前 reject 让上层
      // 换节点,started 之后只能就地收尾。
      //
      // 特别是空闲超时:它触发的是 socket 的 timeout,ClientRequest 也会跟着
      // emit 一次 'timeout'。不区分状态的话那条路会带着 notStarted:true 回到
      // 重试循环里,而此时头早就发出去了。
      let started = false;
      let settled = false;
      let usage = null;     // 提到这一层:r 的 error 回调也要把已收到的 usage 带出去
      // 流式的「首字」量的是等到第一个 chunk 有多久,不是响应头到达的时刻:
      // 推理模型 200 之后还要想几十秒才吐第一个字,量头等于把那段等待抹掉,
      // 而那段等待恰恰是用户真正在等的东西。
      const t0 = Date.now();
      let firstByte = 0;
      const finish = (fn) => { if (!settled) { settled = true; fn(); } };

      /**
       * 保活心跳。覆盖整条流,不是只活到首字节 —— 长任务的静默主要发生在中段
       * (吐一段推理后停下来想、工具调用之间空转),而不是只在开头。网关到上游有 TCP
       * keepalive 撑着,但网关到客户端中间还隔着宝塔 nginx(默认 proxy_read_timeout
       * 60s)和客户端自己的空闲上限。详见 StreamKeepAlive。
       */
      let keepAlive = null;
      const stopHeartbeat = () => { keepAlive?.stop(); keepAlive = null; };

      const r = https.request(this.reqOpts(bodyStr, { accept: 'text/event-stream', timeout: ttfb, identity, path: dialect.path, agent }), (resp) => {
        if (resp.statusCode !== 200) {
          // 还没 writeHead,可以安全重试:收完 body 让上层判是 429 还是别的
          let data = '';
          resp.on('data', (c) => (data += c));
          resp.on('end', () => {
            const retryAfter = parseRetryAfter(resp.headers['retry-after']);
            finish(() => reject({ status: resp.statusCode, body: data, notStarted: true, retryAfter }));
          });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        started = true;
        keepAlive = new StreamKeepAlive((s) => res.write(s));
        const sink = dialect.sink(res, body.model);

        // 首字节已到,把「等第一个字节」的短超时换成宽松的空闲超时:
        // 推理模型思考几十秒很正常,拿 TTFB 那个尺度掐会毁掉已经成功的请求
        r.setTimeout(0);
        resp.setTimeout(STREAM_IDLE_MS, () => {
          this.logger('error', `[stream] 空闲超过 ${STREAM_IDLE_MS / 1000}s,断开`);
          r.destroy();
        });

        let buf = '';
        resp.on('data', (chunk) => {
          // 保活计时重置:活跃的流不发 ping,静默满一个间隔才补
          keepAlive?.touch();
          firstByte ||= Date.now() - t0;
          sink.write(chunk);          // 先转发,统计是副产品,别让它拖慢流
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();          // 末行可能被截断,留着等下一个 chunk
          for (const line of lines) {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
            try {
              const j = JSON.parse(line.slice(6));
              // usage 可能在三处:chat 流的顶层 j.usage(Responses 漏块型模型收尾
              // 漏出的 chat.completion.chunk 也在这)、Responses 干净型模型的
              // response.completed.response.usage。两套命名的归一交给 readUsage。
              const u = j.usage || j.response?.usage;
              if (u) usage = u;
            } catch {}
          }
        });
        resp.on('end', () => finish(() => {
          stopHeartbeat();
          sink.end();
          resolve({ ok: true, usage, ttfb: firstByte });
        }));
        resp.on('error', (e) => finish(() => {
          stopHeartbeat();
          this.logger('error', `[stream] 中断: ${e.message}`);
          // sink.fail 会补一个合法收尾(Anthropic 那边是 error + message_stop),
          // 客户端的状态机于是能正常结束,而不是等到自己超时
          sink.fail(e.message);
          resolve({ ok: false, usage, ttfb: firstByte });   // 已经发出去一部分了,重试不了,不算可重试失败
        }));
      });

      r.on('error', (e) => finish(() => {
        stopHeartbeat();
        if (started) {
          // 头已经发了,只能就地收尾。这里不能 reject 回重试循环。
          this.logger('error', `[stream] 传输中断: ${e.message}`);
          try { res.end(); } catch {}
          return resolve({ ok: false, usage, ttfb: firstByte });
        }
        reject({ status: 0, body: e.message, notStarted: true });
      }));
      r.on('timeout', () => {
        if (started) return;    // 空闲超时归 resp.setTimeout 管,这里不插手
        r.destroy();
        finish(() => reject({ status: 0, body: `stream ttfb timeout after ${ttfb}ms`, notStarted: true }));
      });
      r.end(bodyStr);
    });
  }
  // ── mihomo 控制端口 ───────────────────────────────────

  async getAllNodes() {
    if (this.nodeCache && Date.now() - this.nodeCacheTime < 30_000) return this.nodeCache;
    try {
      const r = await this.mihomoApi(`/proxies/${encodeURIComponent(POOL_NAME)}`);
      this.nodeCache = r.all || [];
      this.nodeCacheTime = Date.now();
      return this.nodeCache;
    } catch (e) {
      this.logger('error', `[mihomo] 取节点失败: ${e.message}`);
      return [];
    }
  }

  async getCurrentNode() {
    try {
      return (await this.mihomoApi(`/proxies/${encodeURIComponent(POOL_NAME)}`)).now;
    } catch { return null; }
  }

  async switchNode(name) {
    // 并发请求撞在一起时等前一次切完,而不是各自去切
    while (this.switching) {
      await sleep(100);
      if ((await this.getCurrentNode()) === name) return true;
    }
    this.switching = true;
    try {
      await this.mihomoApi(`/proxies/${encodeURIComponent(POOL_NAME)}`, 'PUT', JSON.stringify({ name }));
      await sleep(1000);   // 给新节点一点时间把连接建起来
      this.logger('info', `[switch] -> ${name}`);
      return true;
    } catch (e) {
      this.logger('error', `[switch] 失败: ${e.message}`);
      return false;
    } finally {
      this.switching = false;
    }
  }

  /** 让 mihomo 立刻重拉订阅(provider 名字见 config.mjs 的 buildMihomoYaml) */
  async updateProvider() {
    await this.mihomoApi('/providers/proxies/airport', 'PUT');
    this.nodeCache = null;
    this.nodeCacheTime = 0;
  }

  // ── 延迟测试与排序 ────────────────────────────────────

  /**
   * 测一遍全组延迟。用内核自带的 GET /group/{组名}/delay —— 它把组里每个节点
   * 并发 HEAD 一次探针地址,回一张 {节点名: 延迟ms} 的表,没测通的不在表里。
   * 就是各家面板上「延迟测试」那个按钮打的接口,不是跑流量的测速。
   *
   * 为什么不逐个打 /proxies/{名字}/delay:节点名里带斜杠(机场爱在名字里写
   * 「1.4MB/s」),塞进 URL 路径就得指望内核那边把 %2F 正确反转义回来;
   * 而组名是我们自己起的,名字只出现在响应体里,少一整类问题。顺带 17 次
   * 往返变 1 次,并发也交给内核,不用自己控。
   *
   * 配置里 health-check 是 lazy 的(没请求走这个组时不测,省机场流量),
   * 所以内核自己不会给出这份数据,必须显式点一遍。
   */
  async testNodes() {
    if (this.testing) return this.testing;        // 已经在测了就搭车,别测两遍
    this.testing = this._testNodes().finally(() => { this.testing = null; });
    return this.testing;
  }

  async _testNodes() {
    const list = await this.getAllNodes();
    if (!list.length) return { tested: 0, alive: 0, dead: [], fastest: null, ms: 0 };

    const t0 = Date.now();
    const q = `timeout=${HEALTH_TIMEOUT_MS}&url=${encodeURIComponent(HEALTH_URL)}`;
    let mp = {};
    let why = '';
    try {
      mp = await this.mihomoApi(`/group/${encodeURIComponent(POOL_NAME)}/delay?${q}`);
    } catch (e) {
      // 全灭时内核回 500 all proxies timeout;参数不对会回 400。两种都得能看见,
      // 不然「全都测不通」到底是节点的问题还是我们请求的问题根本分不出来。
      why = e.message;
    }
    // 以订阅里的节点表为准建这张图:内核只回测通的,没回的就是不通
    const found = new Map(list.map((n) => {
      const d = Number(mp?.[n]);
      return [n, Number.isFinite(d) && d > 0 ? d : null];
    }));

    // 整表替换而不是合并:节点可能已经被机场下掉了,留着旧数据会让
    // rankNodes 以为它还在
    this.delay = found;
    this.testedAt = Date.now();

    const alive = [...found].filter(([, d]) => d != null);
    const dead = [...found].filter(([, d]) => d == null).map(([n]) => n);
    alive.sort((a, b) => a[1] - b[1]);

    // 锁定的那个节点测不通就解锁,否则 ensureNode 会一直粘着它,直到某次请求
    // 真的失败才换 —— 已经知道它不通了,没必要拿真实请求去验
    if (this.lockedNode && found.get(this.lockedNode) === null && alive.length) {
      this.logger('warn', `[delay] 锁定节点 ${this.lockedNode} 已不可用,解锁`);
      this.lockedNode = null;
    }

    const ms = Date.now() - t0;
    const secs = (ms / 1000).toFixed(1);
    if (alive.length) {
      this.logger('ok', `[delay] 测完 ${found.size} 个,可用 ${alive.length},最快 ${alive[0][0]} ${alive[0][1]}ms(耗时 ${secs}s)`);
      if (dead.length) this.logger('warn', `[delay] 剔除 ${dead.length} 个不可用: ${dead.join(', ')}`);
    } else {
      // 全灭基本不是 17 个节点同时死,而是探针地址这些节点到不了。
      // 把原因和探针地址一起打出来,不然只能猜。
      this.logger('warn', `[delay] ${found.size} 个节点全都测不通(耗时 ${secs}s)${why ? `,内核回:${why}` : ''}`);
      this.logger('warn', `[delay] 探针是 ${HEALTH_URL},这次不剔除任何节点;换个地址试试 NODE_TEST_URL=`);
    }
    return {
      tested: found.size, alive: alive.length, dead,
      fastest: alive[0] ? { node: alive[0][0], delay: alive[0][1] } : null, ms,
    };
  }

  /**
   * 排序 = 优先级:网关挑节点就是取这个数组的第一个可用项。两级键:
   *  1. 最近被限流的时刻(recentMark,没限流过=0 最优先)—— 把刚限流/解冻的节点
   *     让到队尾,免得延迟最低的那个一解冻就插回队首、又被打,后面的节点饿死;
   *  2. 实测延迟。没被限流过的节点之间,还是快的在前。
   *
   * 两条兜底:
   *  - 没测过的节点(测完之后机场新加的)保留,排在测过的后面而不是当死的扔掉;
   *  - 全灭时原样返回。探针地址被封、DNS 挂了都会让所有节点报不通,
   *    这时候剔除等于把整个网关关掉,而实际上打 opencode 可能是通的。
   *
   * 不在这儿打日志:面板每 2 秒轮一次 /api/nodes,而 excludedNodes 还会再调
   * 一遍,一次全灭能刷出一屏。原因由 _testNodes 那两条负责说清楚。
   */
  rankNodes(nodes) {
    if (!this.delay.size) return nodes;
    const untested = nodes.filter((n) => !this.delay.has(n));
    const alive = nodes.filter((n) => this.delay.get(n) != null);
    if (!alive.length && !untested.length) return nodes;
    alive.sort((a, b) =>
      (this.cooldown.recentMark(a) - this.cooldown.recentMark(b))
      || (this.delay.get(a) - this.delay.get(b)));
    return [...alive, ...untested];
  }

  /** 被剔除的节点,面板要显示出来 —— 静默消失会让人以为订阅少了节点 */
  excludedNodes(nodes) {
    if (!this.delay.size) return [];
    const kept = new Set(this.rankNodes(nodes));
    return nodes.filter((n) => !kept.has(n));
  }

  delayMap() {
    return Object.fromEntries(this.delay);
  }

  mihomoApi(p, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: CTRL_PORT, path: p, method, timeout: 10_000,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      }, (resp) => {
        let data = '';
        resp.on('data', (c) => (data += c));
        resp.on('end', () => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            // 带上内核的错误体({"message":"..."})。只报「HTTP 500」的话,
            // 「节点全超时」和「我们参数写错了」在日志里长得一模一样
            let msg = '';
            try { msg = JSON.parse(data)?.message || ''; } catch { msg = data.trim().slice(0, 120); }
            return reject(new Error(`HTTP ${resp.statusCode}${msg ? `: ${msg}` : ''}`));
          }
          if (method !== 'GET') return resolve({});
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end(body ?? undefined);
    });
  }

  async restoreLastNode() {
    try {
      if (!fs.existsSync(LAST_NODE_FILE)) return;
      const last = fs.readFileSync(LAST_NODE_FILE, 'utf8').trim();
      if (!last || (await this.getCurrentNode()) === last) return;
      if ((await this.getAllNodes()).includes(last)) {
        this.logger('info', `[memo] 恢复上次节点: ${last}`);
        await this.switchNode(last);
      }
    } catch {}
  }

  saveLastNode(name) {
    try { fs.writeFileSync(LAST_NODE_FILE, name, 'utf8'); } catch {}
  }

  forgetLastNode() {
    try { fs.rmSync(LAST_NODE_FILE, { force: true }); } catch {}
  }

  // ── 子 lane 生命周期 ─────────────────────────────────

  /**
   * 拉起一个子 lane:独立 mihomo 进程 + 独立端口 + 独立数据目录,只为固定走
   * 某个节点。它不拉订阅(配置里 provider 直接引用主 lane 的订阅 url),
   * 不维护冷却(全在主进程 Gateway 内存里)。subscriptionUrl 由调用方传入。
   */
  async _spawnChildLane({ node, nodes, mainNode }) {
    const id = ++this._laneSeq;
    const { mixedPort, ctrlPort } = lanePorts(id);
    const dataDir = laneDataDir(id);
    const configFile = writeMihomoConfig(this.config.subscriptionUrl, { mixedPort, ctrlPort, name: `lane${id}` });

    const inst = new MihomoInstance({
      configFile,
      dataDir,
      ctrlPort,
      label: `lane${id}`,
    });
    await inst.start(this.logger);

    // inst.start 只保证控制端口就绪,provider 还在异步拉订阅。等子 lane 自己的
    // 节点表出来(带 | 的节点名必须用它自己那份为准,不能拿主 lane 的名字硬切)。
    const own = await this._childNodes(inst);
    if (!own.length) {
      await inst.stop(this.logger);
      throw new Error(`子 lane ${id} 拉不到节点`);
    }
    // 选节点只认子 lane 自己的表:
    //   1. 主 lane 选定的 node 在子表里存在 → 用同一个(同一订阅,名字一致)
    //   2. 不存在 → 在子表里挑第一个 ≠ mainNode 的节点,保证出口和主 lane 不同
    //   3. 子表只剩 mainNode → 退到 own[0],至少让请求走通
    // 关键点:子 lane 是独立 mihomo 进程,它有自己那份订阅快照,节点名可能和
    // 主 lane 的缓存对不上 —— 绝不能用主表选出的名字去硬切(会 400 proxy not exist)。
    const prefer = node && own.includes(node) ? node : null;
    const chosen = prefer
      ?? own.find((n) => n !== mainNode)
      ?? own[0];
    const ok = await this._childSwitch(inst, chosen);
    if (!ok) {
      await inst.stop(this.logger);
      throw new Error(`子 lane ${id} 无法切换到节点 ${chosen}`);
    }
    const lane = {
      id,
      node: chosen,
      nodes: own,
      inst,
      ctrlPort,
      mixedPort,
      agent: new MihomoAgent(mixedPort),
      active: 0,
      lastUsed: this.lanes.now(),
    };
    this.logger('ok', `[lane${id}] 已拉起,绑定节点 ${chosen} (mixed ${mixedPort} / ctrl ${ctrlPort})`);
    return lane;
  }

  /** 轮询子 lane 自己的 zen-pool 节点表,最多等 30s(provider 拉订阅需要时间) */
  async _childNodes(inst) {
    for (let waited = 0; waited < 30_000; waited += 500) {
      try {
        const r = await this._mihomoApi(inst.ctrlPort, `/proxies/${encodeURIComponent(POOL_NAME)}`);
        if (Array.isArray(r?.all) && r.all.length) return r.all;
      } catch { /* provider 还没拉完,继续等 */ }
      await new Promise((res) => setTimeout(res, 500));
    }
    return [];
  }

  async _destroyChildLane(lane) {
    try {
      this.logger('info', `[lane${lane.id}] 空闲回收,关闭节点 ${lane.node}`);
      await lane.inst?.stop(this.logger);
    } catch (e) {
      this.logger('warn', `[lane${lane.id}] 回收失败: ${e.message}`);
    }
  }

  /** 经子 lane 的控制端口切节点(它有自己的 ctrl 端口,不能动主 lane 的 selector) */
  async _childSwitch(inst, name) {
    try {
      const r = await this._mihomoApi(inst.ctrlPort, `/proxies/${encodeURIComponent(POOL_NAME)}`, 'PUT', JSON.stringify({ name }));
      return !!r;
    } catch (e) {
      this.logger('error', `[lane] 子实例切换失败: ${e.message}`);
      return false;
    }
  }

  /** 经指定 ctrl 端口发控制请求。默认主 lane(CTRL_PORT)。 */
  _mihomoApi(ctrlPort = CTRL_PORT, p, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: ctrlPort, path: p, method, timeout: 10_000,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      }, (resp) => {
        let data = '';
        resp.on('data', (c) => (data += c));
        resp.on('end', () => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            let msg = '';
            try { msg = JSON.parse(data)?.message || ''; } catch { msg = data.trim().slice(0, 120); }
            return reject(new Error(`HTTP ${resp.statusCode}${msg ? `: ${msg}` : ''}`));
          }
          if (method !== 'GET') return resolve({});
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end(body ?? undefined);
    });
  }

  /** mihomoApi 仍走主 lane 控制端口 */
  mihomoApi(p, method = 'GET', body = null) {
    return this._mihomoApi(CTRL_PORT, p, method, body);
  }

  /**
   * 为一次请求拿一个 lane。主 lane 忙时按实时节点快照看能否开子 lane;
   * 没有独立节点或已达上限就回落主 lane,绝不丢请求。
   */
  async acquireLane({ nodes, mainNode, available }) {
    return this.lanes.acquire({ nodes, mainNode, available });
  }

  /** 经子 lane 控制端口查当前节点 */
  async _childGetCurrent(inst) {
    try {
      return (await this._mihomoApi(inst.ctrlPort, `/proxies/${encodeURIComponent(POOL_NAME)}`))?.now ?? null;
    } catch { return null; }
  }

  /** 回收空闲子 lane。定时器/退出路径调用。 */
  async reapIdleLanes() {
    try { await this.lanes.reap(); } catch (e) {
      this.logger('warn', `[lane] 回收异常: ${e.message}`);
    }
  }

  /** 退出时回收全部子 lane(主 lane 由 mihomo.stop 管) */
  async stopChildLanes() {
    await this.lanes.clear();
  }
}

export function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
