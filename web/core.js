/**
 * core.js —— UI 的纯展示逻辑。
 *
 * 这一层不碰 DOM、不发请求,所以 test/check.mjs 可以直接 import 断言。
 * 界面里凡是「算出来的东西」都放这儿,app.js 只负责把结果贴到 DOM 上。
 */

/** 节点 429 后的兜底冷却窗口,与网关侧 COOLDOWN_MS 一致(无 Retry-After 时 60 秒) */
export const COOLDOWN_MS = 60_000;

/** 日志环形缓冲上限,与网关侧 MAX_LOG 一致 */
export const MAX_LOG = 500;

export const LOG_LEVELS = { info: '信息', ok: '成功', warn: '警告', error: '错误' };

const grouped = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 12345 -> "12,345" */
export function fmtCount(n) {
  return grouped.format(Number(n) || 0);
}

/** 1234567 -> "1.2M";token 数动辄七位,面板上放不下全长 */
export function fmtTokens(n) {
  return compact.format(Number(n) || 0);
}

/** 上下文用不带小数的紧凑写法:262144 -> "262K"。1M 级的都取整成 "1M" */
const ctxFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 });

/**
 * "mimo-v2.5-free" -> "mimo-v2.5-free[1M]";查不到上限的原样返回。
 *
 * 上限从哪来:`/api/status` 的 `ctx`,也就是服务端 `server/capabilities.mjs`
 * 那份**实测记录**(上游 `/zen/v1/models` 一个字节的元数据都不给,models.dev
 * 那份对至少 4 个模型是错的 —— 给 deepseek-v4-flash-free 写 200000,真值
 * 1048576)。这张表以前是手写在这个文件里的常量,代价付过两次:新模型上线不会
 * 自动长出来,下线的模型倒是一直挂着。现在服务端只给当前清单里那些,前端拿到
 * 什么显示什么。
 *
 * 服务端还没探到的(比如刚上线的模型、或者开机那次撞上限流)这里查不到,
 * 就只显示模型名 —— 少个括号,不影响清单本身。
 */
export function modelLabel(id, ctxMap) {
  const ctx = Number(ctxMap?.[id]);
  return ctx > 0 ? `${id}[${ctxFmt.format(ctx)}]` : String(id ?? '');
}

/**
 * 面板模型状态只接受后端约定的四种值。缺记录、旧网关或坏值统一归为
 * unknown:网络抖动不能被误画成模型已下线。message 只展示明确的上游
 * 不可用原因,避免把限流/连接错误混进模型状态。
 */
const MODEL_STATE_LABELS = {
  unknown: '状态未知',
  probing: '探测中',
  available: '可用',
  unavailable: '不可用',
};

export function modelState(id, availability) {
  const raw = availability && typeof availability === 'object' ? availability[id] : null;
  const candidate = String(raw?.status ?? '').trim().toLowerCase();
  const status = Object.hasOwn(MODEL_STATE_LABELS, candidate) ? candidate : 'unknown';
  const message = status === 'unavailable'
    ? String(raw?.error?.message ?? '').trim()
    : '';
  return {
    status,
    label: MODEL_STATE_LABELS[status],
    message,
    muted: status === 'unavailable',
  };
}

/** 毫秒时长 -> 中文粗粒度,只保留两级单位 */
export function fmtUptime(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 时`;
  if (h) return `${h} 时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** ISO 时间戳 -> HH:MM:SS(本地时区);日志每行都要,坏值不能炸 */
export function fmtClock(ts) {
  const d = ts == null ? new Date() : new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8);
}

/**
 * 成功率。没有任何请求时返回 null —— 显示 0% 会让人以为全挂了,
 * 而实际是「还没跑过」。调用方据此显示占位符。
 */
export function successRate(total) {
  const req = Number(total?.requests) || 0;
  if (!req) return null;
  return (Number(total?.success) || 0) / req;
}

/** 0.9231 -> "92.3%" */
export function fmtPercent(r) {
  return r == null ? '—' : `${(r * 100).toFixed(1)}%`;
}

/**
 * 后端给的冷却剩余是「秒」且算在服务端。UI 要在两次轮询之间自己走秒,
 * 所以收到的那一刻先折算成本地截止时间戳,之后都拿它跟 now 比。
 */
export function cooldownDeadline(remainSec, now = Date.now()) {
  return now + Math.max(0, Number(remainSec) || 0) * 1000;
}

export function remainMs(deadline, now = Date.now()) {
  return Math.max(0, (Number(deadline) || 0) - now);
}

/**
 * 合并节点列表 + 冷却表 + 当前/锁定节点,产出可直接渲染的行。
 *
 * 排序刻意对齐网关的挑选顺序:可用的在前(且保持后端给的顺序 —— 后端已经按
 * 实测延迟排过,pickAvailable 取的就是列表里第一个不冷却的),冷却中的排最后、
 * 剩余时间短的靠前(对应「全部冷却时选剩余最短的」),测不通的(excluded)
 * 垫在最底下。所以这个列表从上往下读就是网关接下来会用的顺序。
 *
 * delay: { 节点名: 毫秒 | null }。null / 缺失 = 没有实测数据,显示成 '—'
 * 而不是 0ms —— 0ms 是个具体的谎。
 */
export function nodeRows({ nodes = [], cooldowns = [], current = '', locked = '', delay = {}, excluded = [], now = Date.now() } = {}) {
  const cooling = new Map();
  for (const c of cooldowns) {
    if (!c?.node) continue;
    const ms = remainMs(c.deadline ?? cooldownDeadline(c.remain, now), now);
    if (ms > 0) cooling.set(c.node, ms);
  }

  const mk = (name, i, dead) => {
    const remain = cooling.get(name) || 0;
    const d = Number(delay?.[name]);
    // 冷却优先于 active:当前节点正被限流时它其实不可用,标成 active 是骗人
    const state = dead ? 'dead' : remain > 0 ? 'cooling' : name === current ? 'active' : 'idle';
    return {
      name, i, remain, state,
      latency: dead ? null : Number.isFinite(d) && d > 0 ? d : null,
      locked: name === locked, ratio: remain / COOLDOWN_MS,
    };
  };

  const rows = (nodes || []).map((name, i) => mk(name, i, false));
  const rank = { active: 0, idle: 1, cooling: 2 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || a.remain - b.remain || a.i - b.i);

  // 被剔除的接在后面,自己按名字排;它们不参与轮换,顺序没有语义
  const dead = (excluded || []).filter((n) => !(nodes || []).includes(n))
    .map((name, i) => mk(name, rows.length + i, true))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...rows, ...dead];
}

/**
 * 毫秒 -> 显示文本,逐级向上换单位。没测过是 '—',不是 0。
 *
 * 分钟那一档是给「平均耗时」用的:请求预算 75s,推理模型跑满很常见,
 * 「92.4s」要在脑子里除一次才知道是一分半。节点延迟那边到不了这一档。
 */
export function fmtDelay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 60_000) return `${(n / 60_000).toFixed(1)}m`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/**
 * 延迟分档,给徽章上色。阈值按「能不能用」而不是好看:
 * 300ms 以内是直连级,1s 以上光握手就要等一下,算差。
 */
export function delayGrade(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 300) return 'fast';
  if (n < 1000) return 'mid';
  return 'slow';
}

/** 「上次测延迟」显示成相对时间;它是手动/事件触发的,绝对时刻没意义 */
export function fmtAgo(ts, now = Date.now()) {
  const t = Number(ts);
  if (!t) return '还没测过';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} 秒前测`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前测`;
  return `${Math.floor(s / 3600)} 小时前测`;
}

/** 追加日志并裁到上限。用 splice 而非 shift:一次灌入多条也能裁干净 */
export function pushLog(buf, line, max = MAX_LOG) {
  buf.push(line);
  if (buf.length > max) buf.splice(0, buf.length - max);
  return buf;
}

/** 面板默认不显示完整 key,点「显示」才展开 */
export function maskKey(k) {
  const s = String(k ?? '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return s.slice(0, 4) + '•'.repeat(Math.min(12, s.length - 8)) + s.slice(-4);
}

/**
 * 客户端要填的 base URL。
 *
 * 直接取当前访问地址,不拼进程自己的监听端口 —— 面板和 /v1 是同一个 server,
 * 所以「你现在能打开这个面板的地址」必然也是「客户端能打到 /v1 的地址」。
 * 而进程端口在反代或端口映射后面往往和外部地址无关:容器里听 9527、
 * compose 映射成别的、再套一层 Caddy 走 80/443,拼出来的
 * http://host:9527/v1 就是个连不上的地址。
 *
 * origin 已经带了协议和「非默认才出现」的端口(https://h/ 不带 443、
 * http://h:8080/ 带 8080),正是需要的行为,不用自己判断。
 * 没有 origin 可用(比如 file:// 打开)时退回本机默认,总比给个空串好。
 */
function baseOrigin(origin) {
  return String(origin ?? '').replace(/\/+$/, '') || 'http://localhost:9527';
}

/** OpenAI 协议 base URL:带 /v1(客户端只往后拼 /chat/completions)。 */
export function endpointBase(origin) {
  return `${baseOrigin(origin)}/v1`;
}

/**
 * Anthropic 协议 base URL:裸地址,不带 /v1。Claude Code 这类客户端自己拼
 * /v1/messages —— base 再带 /v1 就成了 /v1/v1/messages,握手直接 404。
 */
export function anthropicBase(origin) {
  return baseOrigin(origin);
}

/**
 * byModel / byDay 这种 { key: {requests,...} } 映射 -> 按成功次数降序的数组。
 *
 * 排序和显示都用 success 而不是 requests:面板上那格叫「模型统计」,一个模型
 * 每次都 429 却排在榜首没有意义 —— 「哪个模型真的在为我干活」才是要看的。
 * requests/totalTokens 一并带出来,调用方要总量时不用再翻原始映射。
 * 一次都没成功过的直接不出现:列一行 0 只是占位,列表要留给有量的那几个。
 * limit = 0 表示不截断(模型统计那格全量显示,自己滚动)。
 */
export function rankBreakdown(map, limit = 5) {
  const rows = Object.entries(map || {})
    .map(([key, v]) => ({
      key,
      success: Number(v?.success) || 0,
      requests: Number(v?.requests) || 0,
      totalTokens: Number(v?.totalTokens) || 0,
    }))
    .filter((r) => r.success > 0)
    .sort((a, b) => b.success - a.success || a.key.localeCompare(b.key));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/**
 * 生成配置提交体。只切身份头时省略没变的订阅地址，避免服务端把它解释为
 * 「用户明确保存订阅」并强制重拉；点击保存且订阅变更/明确强制时仍发送地址。
 */
export function updateHours(value) {
  if (value === '') return 0;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 8760 ? n : null;
}

export function configPayload({
  savedUrl = '', url = '', savedIdentity = false, identity = false,
  savedUpdateHours = 0, updateHours: hours = 0,
} = {}) {
  const out = {
    opencodeIdentityHeaders: identity === true,
    subscriptionUpdateHours: hours,
  };
  // 只改开关或周期时不碰订阅；否则点击「保存并应用」仍保持原有的强制刷新语义。
  if (url !== savedUrl || (identity === savedIdentity && hours === savedUpdateHours)) out.subscriptionUrl = url;
  return out;
}

/**
 * 缓存命中率 = 读到的缓存 token ÷ 输入 token。
 *
 * 分母为 0 时返回 null:上游不报 cached_tokens 的时候,显示「0%」等于断言
 * 「试过、一次没命中」,而真相是「不知道」。这两件事在调身份头实验的时候
 * 恰恰是最需要分清的 —— 所以宁可显示 —。
 */
export function cacheRate(b) {
  if (!b || b.hasCacheData === false) return null;
  const cached = Number(b.cacheReadTokens) || 0;
  // 兼容 hasCacheData 引入前已写入的桶：非零缓存读数本身足以证明上游报过数据。
  if (b.hasCacheData !== true && cached <= 0) return null;
  const pt = Number(b.promptTokens) || 0;
  if (pt <= 0) return null;
  return cached / pt;
}

/**
 * byNode -> 可直接渲染的行 + 汇总。
 *
 * 这套数和顶部总览刻意不是一回事:总览按**客户端请求**记,一次请求换三个
 * 节点也只算一次;这里按**每次真实上游尝试**记,那次请求会在三个节点上各
 * 留一笔。所以各行 requests 加起来通常大于总览的请求数,那不是 bug,而是
 * 「为了完成这些请求,底下实际打了多少次」——两个数一样才说明从没重试过。
 *
 * 耗时另算:后端只给成功的尝试记时,所以样本数和 requests 不是一回事,
 * 平均值得拿自己那个 count 当分母(见 gateway.mjs 的 blankNode)。
 */
export function nodeStats(byNode) {
  const totals = { requests: 0, success: 0, rateLimited: 0, timeout: 0, upstreamError: 0 };
  // 平均值不能对各节点的平均再平均 —— 那是把跑了 800 次的节点和跑了 3 次的
  // 等权看待。先把总和与样本数攒起来,最后除一次
  const acc = { ttfbMs: 0, ttfbCount: 0, durationMs: 0, durationCount: 0 };
  const rows = [];
  for (const [name, v] of Object.entries(byNode || {})) {
    const n = (k) => Number(v?.[k]) || 0;
    const requests = n('requests');
    if (!requests) continue;        // 一次都没试过的节点不占位置
    const row = { name, requests };
    for (const k of ['success', 'rateLimited', 'timeout', 'upstreamError',
      'promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens',
      'cacheReadTokens', 'cacheWriteTokens']) row[k] = n(k);
    // undefined 要保留给 cacheRate 做旧桶兼容；强制成 false 会把历史非零缓存误判成无数据。
    row.hasCacheData = v?.hasCacheData;
    // 最近一次这个节点发出去的模型和思考强度。旧桶没这两个字段 → ''(前端显示 —)
    row.lastModel = String(v?.lastModel ?? '').trim();
    row.lastEffort = String(v?.lastEffort ?? '').trim();
    row.rate = successRate(row);     // 字段名对得上,直接复用总览那个
    row.cache = cacheRate(row);
    row.ttfb = avgMs(n('ttfbMs'), n('ttfbCount'));
    row.duration = avgMs(n('durationMs'), n('durationCount'));
    row.lastAt = n('lastAt');
    rows.push(row);
    for (const k of Object.keys(totals)) totals[k] += row[k];
    for (const k of Object.keys(acc)) acc[k] += n(k);
  }
  // 最近打过的排最上面。按尝试数排的话,一个跑了几百次、早就被换掉的节点会
  // 常驻榜首,而「现在在用哪个、刚出的问题出在谁身上」得往下翻才看得到。
  // lastAt 缺失(旧桶)记 0 自然垫底,同分再退回原来那套尝试数 + 名字的稳定排序
  rows.sort((a, b) => b.lastAt - a.lastAt || b.requests - a.requests || a.name.localeCompare(b.name));
  return {
    rows, totals,
    ttfb: avgMs(acc.ttfbMs, acc.ttfbCount),
    duration: avgMs(acc.durationMs, acc.durationCount),
  };
}

/**
 * calls -> 可直接渲染的行 + 汇总。最近的排最前。
 *
 * 和 nodeStats 的区别就是这个模块存在的理由:那边按节点聚合,一个节点只留
 * 得下「最近一次用的模型和强度」;这边每条成功调用独立一行,同一个节点连着
 * 跑十次不同档位能看到十行。排查「客户端设了 max 却没生效」要的是后者 ——
 * 聚合值只告诉你最后一次是什么,看不出中间被谁改过。
 *
 * 只有成功的调用会进来(见 gateway.mjs 的 logCall),所以这里没有成功率。
 */
export function callLog(calls) {
  const rows = [];
  const acc = { ttfbMs: 0, ttfbCount: 0, durationMs: 0, durationCount: 0 };
  let tokens = 0;
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c || typeof c !== 'object') continue;
    const n = (k) => Number(c[k]) || 0;
    const row = {
      at: n('at'),
      node: String(c.node ?? '').trim(),
      model: String(c.model ?? '').trim(),
      // '' 保留原样 —— 前端显示 '—',表示没发这个字段(随上游默认)
      effort: String(c.effort ?? '').trim(),
      in: n('in'), out: n('out'), reasoning: n('reasoning'),
      // null 和 0 要分开:测不到首字节和「零延迟」不是一回事
      ttfb: Number.isFinite(Number(c.ttfb)) && Number(c.ttfb) > 0 ? Number(c.ttfb) : null,
      ms: Number.isFinite(Number(c.ms)) ? Number(c.ms) : null,
    };
    row.total = row.in + row.out;
    tokens += row.total;
    if (row.ttfb != null) { acc.ttfbMs += row.ttfb; acc.ttfbCount++; }
    if (row.ms != null) { acc.durationMs += row.ms; acc.durationCount++; }
    rows.push(row);
  }
  // 后端是 push 追加的,所以数组本身就是时间序;倒过来即可,不用比较排序。
  // 同一毫秒内的两条也能保持真实先后 —— 按 at 排序反而会打乱
  rows.reverse();
  return {
    rows, tokens,
    ttfb: avgMs(acc.ttfbMs, acc.ttfbCount),
    duration: avgMs(acc.durationMs, acc.durationCount),
  };
}

/**
 * 平均耗时。没有样本时返回 null —— 显示 0ms 等于断言「这节点零延迟」,
 * 而真相是「还没有成功过、无从得知」。fmtDelay 会把 null 显示成 —。
 */
function avgMs(sum, count) {
  return count > 0 ? sum / count : null;
}

/**
 * 构建标识要不要亮「有新版本」。
 *
 * 比的是两个 hash,而不是直接用后端那次检查返回的 hasUpdate:更新完镜像重启后
 * /api/status 里的 build 就变成 latest,这个函数自己返回 false,标记不用再点一次
 * 「检查更新」才消失。两边缺一个就不亮 —— 本地是 unknown 时新旧无从判断。
 */
export function hasNewer(latest, build) {
  return !!latest && !!build && latest !== build;
}
