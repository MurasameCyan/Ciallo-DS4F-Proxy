/**
 * usage.mjs —— token 用量统计,从 gateway.mjs 拆出来。
 *
 * 两套口径刻意分开(客户端请求 / 节点尝试),原因见 blankNode 上面那段。
 * 这里只认 usage 字段和磁盘,不认网络也不认 Gateway。
 */

import fs from 'node:fs';
import { USAGE_FILE } from './config.mjs';

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
