/**
 * gateway.mjs —— OpenAI 兼容网关 + 节点轮换状态机。
 *
 * 从 desktop-app/gateway.js 移植。行为(冷却 90s、锁定节点、429 换人、
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
import { LAST_NODE_FILE, USAGE_FILE, MIXED_PORT, CTRL_PORT, POOL_NAME } from './config.mjs';
import {
  anthropicToOpenAI, openAIToAnthropic, anthropicError, errTypeFor, AnthropicStream, flattenText,
  reasoningEffort,
} from './anthropic.mjs';
import { safeEqual } from './auth.mjs';

const OPENCODE_HOST = 'opencode.ai';
const CHAT_PATH = '/zen/v1/chat/completions';
const MODELS_PATH = '/zen/v1/models';
export const COOLDOWN_MS = 90 * 1000;

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
export const REQUEST_DEADLINE_MS = 75_000;   // 一个请求从进来到回复的上限
const UPSTREAM_TIMEOUT_MS = 45_000;          // 单次非流式请求的静默上限
const STREAM_TTFB_MS = 45_000;               // 流式:等第一个字节
const STREAM_IDLE_MS = 120_000;              // 流式:开始吐了以后允许的静默
const MAX_NODE_TRIES = 6;                    // 最多换几个节点。48 个全试一遍没意义:
                                             // 连续 6 个都 429 基本就是整体被限了
const MIN_TRY_MS = 8_000;                    // 剩这么点时间就别再开新的尝试了

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
 * 面板于是少列一个能用的模型。所以现在它只是 fallback。
 */
export const FREE_MODELS = [
  'deepseek-v4-flash-free',
  'big-pickle',
  'mimo-v2.5-free',
  'laguna-s-2.1-free',
  'ling-3.0-flash-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
];

/** 免费清单的 TTL。上游几周才动一次,拉太勤没意义(还多一次经节点的出站) */
const MODELS_TTL_MS = 30 * 60 * 1000;

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
 * 方言。/v1/chat/completions 和 /v1/messages 共用同一套节点轮换、冷却、重试,
 * 差别只有三件事:请求怎么进来、成功体怎么写回去、错误体和 SSE 事件长什么样。
 * 把这三件事收进一个对象,轮换逻辑就完全不用知道自己在服务哪个 API ——
 * 否则每个 return 点都要 if (isAnthropic),漏一个就是形状错乱的响应。
 */
export const OPENAI = {
  name: 'openai',
  /** 客户端选哪个模型就用哪个 —— handleChat 已经拿实时免费清单挡过一道了 */
  toUpstream: (body) => body,
  validate: (b) => (Array.isArray(b.messages) && b.messages.length ? null : 'messages required'),
  fail: (res, status, message, type, extra) => json(res, { error: { message, type, ...extra } }, status),
  respond: (res, oai) => json(res, oai),
  sink: (res) => rawSink(res),
};

export const ANTHROPIC = {
  name: 'anthropic',
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
  respond: (res, oai, model) => json(res, openAIToAnthropic(oai, model)),
  sink: (res, model) => anthropicSink(res, model),
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
 * 上游 usage → 统一字段名。
 *
 * 缓存 token 各家字段名都不一样,而上游会把底层模型的 usage 原样带出来,
 * 所以见到哪个认哪个:OpenAI 是 prompt_tokens_details.cached_tokens,
 * Anthropic 风格是 cache_read_input_tokens / cache_creation_input_tokens。
 * 一个都没有时 token 仍归一成 0,另用 hasCacheData 标明「无数据」,
 * 避免面板把「上游没报」误显示成「明确 0%」。
 */
export function readUsage(u) {
  const pt = Number(u?.prompt_tokens) || 0;
  const ct = Number(u?.completion_tokens) || 0;
  const num = (...vals) => {
    for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
    return 0;
  };
  const has = (...paths) => paths.some(([obj, key]) => obj != null && Object.hasOwn(obj, key));
  return {
    promptTokens: pt,
    completionTokens: ct,
    reasoningTokens: Number(u?.completion_tokens_details?.reasoning_tokens) || 0,
    totalTokens: Number(u?.total_tokens) || pt + ct,
    cacheReadTokens: num(u?.prompt_tokens_details?.cached_tokens, u?.cache_read_input_tokens, u?.prompt_cache_hit_tokens),
    cacheWriteTokens: num(u?.cache_creation_input_tokens, u?.prompt_tokens_details?.cache_creation_tokens),
    hasCacheData: has(
      [u?.prompt_tokens_details, 'cached_tokens'], [u, 'cache_read_input_tokens'],
      [u, 'prompt_cache_hit_tokens'], [u, 'cache_creation_input_tokens'],
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
  // 会话 ID 依次找这三个:OpenCode 自己的、粘性路由用的、以及通用的那个
  out['x-opencode-session'] = pick('x-opencode-session', 'x-session-affinity', 'x-session-id') || uuid();
  // 这两个没有合理的默认值,客户端没给就别凭空造
  for (const n of ['x-session-id', 'x-title']) {
    const v = pick(n);
    if (v) out[n] = v;
  }
  return out;
}

/** 429 后把节点关小黑屋 90 秒,期间跳过它,避免连续请求撞同一个被限的出口 */
export class NodeCooldown {
  constructor() {
    this.cooldowns = new Map();   // node -> 429 时刻
  }
  mark429(node) { this.cooldowns.set(node, Date.now()); }
  isCooling(node) {
    const t = this.cooldowns.get(node);
    if (!t) return false;
    if (Date.now() - t < COOLDOWN_MS) return true;
    this.cooldowns.delete(node);
    return false;
  }
  clear(node) { this.cooldowns.delete(node); }
  clearAll() {
    const n = this.cooldowns.size;
    this.cooldowns.clear();
    return n;
  }
  pickAvailable(nodes, exclude = null) {
    for (const n of nodes) {
      if (exclude?.has(n)) continue;
      if (this.isCooling(n)) continue;
      return n;
    }
    return null;
  }
  /** 全员冷却时挑剩余最短的,返回 { node, remain }(remain 单位 ms) */
  soonest(nodes) {
    let node = null, remain = Infinity;
    for (const n of nodes) {
      const t = this.cooldowns.get(n);
      if (!t) continue;
      const left = COOLDOWN_MS - (Date.now() - t);
      if (left < remain) { remain = left; node = n; }
    }
    return node ? { node, remain } : null;
  }
  /** 供 /api/nodes 用,remain 单位秒 */
  summary() {
    const out = [];
    for (const [node, t] of this.cooldowns) {
      const left = COOLDOWN_MS - (Date.now() - t);
      if (left > 0) out.push({ node, remain: Math.ceil(left / 1000) });
    }
    return out;
  }
}

/** token 用量统计,持久化到 /data,重启不丢 */
export class UsageTracker {
  constructor(filePath = USAGE_FILE, logger = null) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.filePath)) {
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
          };
        }
      }
    } catch (e) { this.logger?.('warn', `[usage] 读取失败: ${e.message}`); }
    return this.blank();
  }
  blank() {
    return { total: blankTotals(), byDay: {}, byModel: {}, byNode: {}, lastRequest: null, startTime: Date.now() };
  }
  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) { this.logger?.('warn', `[usage] 保存失败: ${e.message}`); }
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
   * call 是这次尝试实际发出的 { model, effort },只记进 lastModel/lastEffort。
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
    if (!usage) return;
    const u = readUsage(usage);
    for (const k of ['promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens',
      'cacheReadTokens', 'cacheWriteTokens']) b[k] += u[k];
    if (u.hasCacheData) b.hasCacheData = true;
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
    this.usage = new UsageTracker(USAGE_FILE, logger);
    this.agent = new MihomoAgent(MIXED_PORT);
    this.nodeCache = null;
    this.nodeCacheTime = 0;
    this.delay = new Map();     // 节点 -> 实测延迟 ms;null = 测过但不通
    this.testedAt = 0;          // 上次测延迟的时刻,0 = 还没测过
    this.testing = null;        // 进行中的延迟测试 Promise,防并发重复测
    this.lockedNode = null;     // 成功后锁定,后续请求直接用,直到 429
    this.switching = false;
    this.paused = false;        // 重启/重置期间置位,请求收 503 而不是打到坏代理上
    this.models = FREE_MODELS;  // 上游那份免费清单,先用兜底常量顶着
    this.modelsAt = 0;          // 上次拉成功的时刻,0 = 还没拉过
    this.modelsFetch = null;    // 进行中的拉取,防并发(面板 2 秒轮一次)
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /** 手动重置:清冷却 + 解锁 + 弃节点缓存(订阅换了以后旧节点名已经不存在了) */
  resetCooldowns() {
    const n = this.cooldown.clearAll();
    this.lockedNode = null;
    this.nodeCache = null;
    this.nodeCacheTime = 0;
    this.logger('ok', `[reset] 清空 ${n} 个冷却记录,重置锁定节点`);
    return n;
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
    json(res, {
      object: 'list',
      data: this.freeModels().map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'opencode-zen' })),
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

  /** 去上游拉一次免费清单。并发调用共用同一个 Promise */
  refreshModels() {
    if (this.modelsFetch) return this.modelsFetch;
    this.modelsFetch = this.upstreamGet(MODELS_PATH)
      .then((d) => {
        const free = pickFreeModels((d?.data || []).map((m) => m?.id));
        // 空结果不接受:上游改了形状或返回了个错误页时,旧清单比空列表有用
        if (!free.length) throw new Error('返回里没有免费模型');
        const added = free.filter((m) => !this.models.includes(m));
        this.models = free;
        this.modelsAt = Date.now();
        if (added.length) this.logger('info', `[models] 免费清单 ${free.length} 个,新增 ${added.join(', ')}`);
        return free;
      })
      .catch((e) => {
        // 只记一次(TTL 内不会重试),继续用上一次的清单
        this.modelsAt = Date.now();
        this.logger('warn', `[models] 拉免费清单失败(${e.message}),继续用上一份 ${this.models.length} 个`);
        return this.models;
      })
      .finally(() => { this.modelsFetch = null; });
    return this.modelsFetch;
  }

  /**
   * GET 上游的公开端点(经 mihomo 出站)。目前只有模型清单用它,所以不做成
   * 通用客户端 —— 和 forward 一样不带 Authorization,那个端点不要鉴权。
   */
  upstreamGet(path, timeout = 8_000) {
    return new Promise((resolve, reject) => {
      const r = https.request({
        host: OPENCODE_HOST, port: 443, path, method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'node' },
        agent: this.agent,
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
    const deadline = Date.now() + REQUEST_DEADLINE_MS;
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8e6) return dialect.fail(res, 413, 'Request too large', 'request_too_large');
    }
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
    body.model = model;

    /**
     * 思考强度。reasoningEffort 从客户端的三种写法(reasoning_effort /
     * reasoning.effort / thinking.budget_tokens)统一转成这个模型认的档位或 ''。
     *
     * 空值不发字段 —— 随上游自己的默认(DS4F 是 high);有值就覆盖掉 body 里
     * 原有的,这样 OpenAI 路径带着的乱值(客户端写了个 foo)和会被上游丢掉的
     * 顶档别名(xhigh)都在这儿收敛掉。Anthropic 路径的 body 已经转换过一遍,
     * 这里用的是同一个函数、同一个 model,结果一致。
     *
     * 必须放在 body.model 定案之后:顶档叫 max 还是 high 取决于模型。
     */
    const effort = reasoningEffort(inbound, model);
    if (effort) body.reasoning_effort = effort;
    else delete body.reasoning_effort;

    // 身份头在这儿构造一次,再传给下面每一次尝试 —— 换节点重试时 request/session ID
    // 必须还是同一个,否则上游看到的是几个互不相干的新会话
    const identity = this.config.opencodeIdentityHeaders ? identityHeaders(req) : null;

    // 排过序的表:延迟低的在前,测不通的直接不在表里。pickAvailable 取的是
    // 「第一个不冷却的」,所以排序在这儿就等于优先级。
    const nodes = this.rankNodes(await this.getAllNodes());
    if (nodes.length === 0) {
      return dialect.fail(res, 503, '没有可用节点 —— 检查订阅地址和 mihomo 状态', 'no_nodes');
    }
    const cur = await this.ensureNode(nodes, res, dialect, deadline);
    if (!cur) return;   // ensureNode 已经回过错误了
    return this.attempt(res, body, nodes, cur, wantStream, dialect, deadline, identity, effort);
  }

  /** Anthropic Messages API 入口。同一条路,只是换个方言。 */
  async handleMessages(req, res) {
    return this.handleChat(req, res, ANTHROPIC);
  }

  /** 选定本次要用的节点并让 mihomo 切过去;返回节点名,失败返回 null(已响应) */
  async ensureNode(nodes, res, dialect = OPENAI, deadline = Infinity) {
    let cur = this.lockedNode;
    if (cur && !this.cooldown.isCooling(cur) && nodes.includes(cur)) return cur;

    cur = this.cooldown.pickAvailable(nodes);
    if (!cur) {
      // 全员冷却:等剩余最短的那个恢复,而不是直接失败
      const s = this.cooldown.soonest(nodes);
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
        this.cooldown.clear(cur);
      } else {
        cur = nodes[0];
      }
    }
    if ((await this.getCurrentNode()) !== cur && !(await this.switchNode(cur))) {
      this.cooldown.mark429(cur);
      dialect.fail(res, 503, 'Switch node failed', 'api_error');
      return null;
    }
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
  async attempt(res, body, nodes, cur, wantStream, dialect = OPENAI, deadline = Infinity, identity = null, effort = '') {
    const tried = new Set();
    const MAX_NET_RETRY = 2;
    let netRetry = 0;
    let switches = 0;
    const left = () => deadline - Date.now();
    const call = { model: body.model, effort };

    // 次数和时间两个上限,谁先到都停。次数防「48 个节点挨个试」,
    // 时间防「每次都慢但都没超时」—— 只有次数上限的话后者能拖到几十分钟。
    while (switches <= MAX_NODE_TRIES) {
      if (left() < MIN_TRY_MS) {
        // 一个字节都还没发出去,所以只记客户端那一笔,不记节点尝试
        this.usage.record(body.model, null, false);
        this.logger('error', `[chat] 超出 ${REQUEST_DEADLINE_MS / 1000}s 预算,放弃(换过 ${switches} 个节点)`);
        return dialect.fail(res, 504, `Upstream did not respond within ${REQUEST_DEADLINE_MS / 1000}s`, 'timeout');
      }
      const t0 = Date.now();
      try {
        const result = wantStream
          ? await this.forwardStream(res, body, dialect, left(), identity)
          : await this.forward(body, left(), identity);

        const dt = Date.now() - t0;
        if (wantStream) {
          // 流式在 forwardStream 里边转发边攒 usage,这儿只拿到结果汇总。
          // ok:false = 首字节之后断的 —— 响应已经发出去一半,重试不了,
          // 但这次尝试对节点来说是上游错误,对客户端来说是一次失败。
          if (result.ok) {
            this.lockedNode = cur;
            this.cooldown.clear(cur);
            this.saveLastNode(cur);
          }
          // 只给成功那次记耗时:中断的那次总耗时量的是「断在第几秒」,
          // 不是这个节点跑完一次要多久,混进平均值里读不出任何东西
          this.usage.recordAttempt(cur, result.ok ? 'success' : 'upstreamError', result.usage,
            result.ok ? { ttfb: result.ttfb, total: dt } : null, call);
          this.usage.record(body.model, result.usage, result.ok);
          this.logger(result.ok ? 'ok' : 'error',
            `[stream-${result.ok ? 'ok' : 'cut'}] node="${cur}" ${dt}ms effort=${effort || '默认'}`);
          return;
        }
        this.lockedNode = cur;
        this.cooldown.clear(cur);
        this.saveLastNode(cur);
        this.usage.recordAttempt(cur, 'success', result.usage, { ttfb: result._ttfb, total: dt }, call);
        this.usage.record(body.model, result.usage, true);
        this.logger('ok', `[ok] node="${cur}" ${dt}ms tokens=${result.usage?.total_tokens ?? '?'}`
          + ` effort=${effort || '默认'}`);
        return dialect.respond(res, result, body.model);
      } catch (e) {
        const status = e.status || 0;

        // 流已经开始吐了就不能重试:头都发出去了,换节点等于给客户端拼接两半响应。
        // 收尾由 forwardStream 里的 sink 负责(它才拿得到那个 sink),这里只记账。
        if (e.notStarted === false) {
          this.usage.recordAttempt(cur, 'upstreamError', null, null, call);
          this.usage.record(body.model, null, false);
          this.logger('error', `[stream-mid] node="${cur}" 中断: ${e.body || e.message}`);
          try { res.end(); } catch {}
          return;
        }

        if (status === 429) {
          this.cooldown.mark429(cur);
          this.usage.recordAttempt(cur, 'rateLimited', null, null, call);
          this.logger('warn', `[429] node="${cur}" 限流,冷却 ${COOLDOWN_MS / 1000}s`);
          tried.add(cur);
          netRetry = 0;

          const next = this.cooldown.pickAvailable(nodes, tried);
          if (!next) {
            const s = this.cooldown.summary();
            this.usage.record(body.model, null, false);
            this.logger('error', `[chat] 全部节点冷却中: ${s.length} 个`);
            return dialect.fail(res, 429,
              `All nodes rate-limited, retry in ~${s[0]?.remain || 90}s`, 'all_nodes_429', { cooldown: s });
          }
          // 换之前喘 2 秒:重置后一口气把所有节点扫成 429 就是这么来的,
          // 上游限流是按窗口算的,给它一点恢复时间
          await sleep(2000);
          switches++;
          if (await this.switchNode(next)) cur = next;
          else {
            tried.add(next);
            const fallback = this.cooldown.pickAvailable(nodes, tried);
            if (!fallback) {
              this.usage.record(body.model, null, false);
              return dialect.fail(res, 503, 'No switchable upstream node', 'all_nodes_unavailable');
            }
            switches++;
            if (await this.switchNode(fallback)) cur = fallback;
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
          if (++netRetry <= MAX_NET_RETRY) {
            this.logger('warn', `[net-retry ${netRetry}/${MAX_NET_RETRY}] node="${cur}": ${e.body || e.message}`);
            await sleep(1000);
            continue;
          }
          tried.add(cur);
          netRetry = 0;
          this.logger('warn', `[timeout] node="${cur}" 重试 ${MAX_NET_RETRY} 次仍失败,换下一个`);
          const next = this.cooldown.pickAvailable(nodes, tried);
          if (!next) {
            this.usage.record(body.model, null, false);
            return dialect.fail(res, 504, 'All nodes timeout', 'timeout');
          }
          switches++;
          if (await this.switchNode(next)) cur = next;
          else {
            tried.add(next);
            const fallback = this.cooldown.pickAvailable(nodes, tried);
            if (!fallback) {
              this.usage.record(body.model, null, false);
              return dialect.fail(res, 503, 'No switchable upstream node', 'all_nodes_unavailable');
            }
            switches++;
            if (await this.switchNode(fallback)) cur = fallback;
            else {
              tried.add(fallback);
              continue;
            }
          }
          continue;
        }

        // 400/500 之类:换节点也是同样结果,直接把上游的话原样带回去
        this.usage.recordAttempt(cur, 'upstreamError', null, null, call);
        this.usage.record(body.model, null, false);
        this.logger('error', `[chat] HTTP ${status}: ${String(e.body).slice(0, 300)}`);
        if (dialect === OPENAI) {
          let payload;
          try { payload = JSON.parse(e.body); } catch { payload = { error: { message: `HTTP ${status}` } }; }
          return json(res, payload, status);
        }
        // Anthropic 客户端只认自己那套错误体,上游的原样转过去它读不懂,
        // 于是把上游的话摘成 message 塞进正确的壳里
        let msg = `HTTP ${status}`;
        try { msg = JSON.parse(e.body)?.error?.message || msg; } catch {}
        return dialect.fail(res, status, msg, errTypeFor(status));
      }
    }
    this.usage.record(body.model, null, false);
    this.logger('error', `[chat] 换过 ${MAX_NODE_TRIES} 个节点仍未成功`);
    return dialect.fail(res, 503,
      `Tried ${MAX_NODE_TRIES} nodes, all unavailable`, 'all_nodes_unavailable');
  }
  // ── 出站 ──────────────────────────────────────────────

  /**
   * 两个 forward 共用的请求选项。
   *
   * 不带 Authorization + User-Agent: node 是刻意的 —— zen 免费端点就认这个形态,
   * 补上 Bearer 反而 401。额度按出口 IP 算,所以换 IP 才是有意义的动作。
   *
   * identity 非空时(实验开关开着)覆盖掉 User-Agent 并补上 OpenCode 那组头,
   * 见 identityHeaders。关着的时候这里的行为和以前一模一样。
   */
  reqOpts(bodyStr, { accept, timeout, identity = null }) {
    return {
      host: OPENCODE_HOST,
      port: 443,
      path: CHAT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        'User-Agent': 'node',
        ...identity,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      agent: this.agent,     // ← 真正经 mihomo 出站的地方
      timeout,
    };
  }

  forward(body, budget = Infinity, identity = null) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify({ ...body, stream: false });
      // 单次超时不能超过整体剩余预算,否则一次慢请求就把预算吃穿
      const timeout = Math.max(1_000, Math.min(UPSTREAM_TIMEOUT_MS, budget));
      const t0 = Date.now();
      const r = https.request(this.reqOpts(bodyStr, { accept: '*/*', timeout, identity }), (resp) => {
        let data = '';
        // 非流式的「首字」= 上游开始回话的时刻。整个 body 是一次攒完的,
        // 所以它和总耗时差的就是传输那点时间,不像流式那样能差几十秒
        let ttfb = 0;
        resp.on('data', (c) => { ttfb ||= Date.now() - t0; data += c; });
        resp.on('end', () => {
          if (resp.statusCode !== 200) return reject({ status: resp.statusCode, body: data });
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
  forwardStream(res, body, dialect = OPENAI, budget = Infinity, identity = null) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify({ ...body, stream: true });
      const ttfb = Math.max(1_000, Math.min(STREAM_TTFB_MS, budget));

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

      const r = https.request(this.reqOpts(bodyStr, { accept: 'text/event-stream', timeout: ttfb, identity }), (resp) => {
        if (resp.statusCode !== 200) {
          // 还没 writeHead,可以安全重试:收完 body 让上层判是 429 还是别的
          let data = '';
          resp.on('data', (c) => (data += c));
          resp.on('end', () => finish(() => reject({ status: resp.statusCode, body: data, notStarted: true })));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        started = true;
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
          firstByte ||= Date.now() - t0;
          sink.write(chunk);          // 先转发,统计是副产品,别让它拖慢流
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();          // 末行可能被截断,留着等下一个 chunk
          for (const line of lines) {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
            try {
              const j = JSON.parse(line.slice(6));
              if (j.usage) usage = j.usage;
            } catch {}
          }
        });
        resp.on('end', () => finish(() => {
          sink.end();
          resolve({ ok: true, usage, ttfb: firstByte });
        }));
        resp.on('error', (e) => finish(() => {
          this.logger('error', `[stream] 中断: ${e.message}`);
          // sink.fail 会补一个合法收尾(Anthropic 那边是 error + message_stop),
          // 客户端的状态机于是能正常结束,而不是等到自己超时
          sink.fail(e.message);
          resolve({ ok: false, usage, ttfb: firstByte });   // 已经发出去一部分了,重试不了,不算可重试失败
        }));
      });

      r.on('error', (e) => finish(() => {
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
   * 按实测延迟排序、剔除不通的。网关挑节点就是取这个数组的第一个可用项,
   * 所以「排序」和「优先级」在这里是同一件事。
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
    alive.sort((a, b) => this.delay.get(a) - this.delay.get(b));
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
}

export function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
