/**
 * core.js —— UI 的纯展示逻辑。
 *
 * 这一层不碰 DOM、不发请求,所以 test/check.mjs 可以直接 import 断言。
 * 界面里凡是「算出来的东西」都放这儿,app.js 只负责把结果贴到 DOM 上。
 */

/** 节点 429 后的冷却窗口,与网关侧 COOLDOWN_MS 一致 */
export const COOLDOWN_MS = 90_000;

/** 日志环形缓冲上限,与网关侧 MAX_LOG 一致 */
export const MAX_LOG = 500;

/** 免费端点可用模型 */
export const FREE_MODELS = [
  'deepseek-v4-flash-free',
  'big-pickle',
  'mimo-v2.5-free',
  'laguna-s-2.1-free',
  'ling-3.0-flash-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
];

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
 * 排序刻意对齐网关的挑选顺序:可用的在前(且保持订阅原序,因为
 * pickAvailable 取列表里第一个不冷却的),冷却中的排最后、剩余时间短的靠前
 * (对应「全部冷却时选剩余最短的」)。所以这个列表从上往下读
 * 就是网关接下来会用的顺序。
 */
export function nodeRows({ nodes = [], cooldowns = [], current = '', locked = '', now = Date.now() } = {}) {
  const cooling = new Map();
  for (const c of cooldowns) {
    if (!c?.node) continue;
    const ms = remainMs(c.deadline ?? cooldownDeadline(c.remain, now), now);
    if (ms > 0) cooling.set(c.node, ms);
  }

  const rows = (nodes || []).map((name, i) => {
    const remain = cooling.get(name) || 0;
    // 冷却优先于 active:当前节点正被限流时它其实不可用,标成 active 是骗人
    const state = remain > 0 ? 'cooling' : name === current ? 'active' : 'idle';
    return { name, i, remain, state, locked: name === locked, ratio: remain / COOLDOWN_MS };
  });

  const rank = { active: 0, idle: 1, cooling: 2 };
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || a.remain - b.remain || a.i - b.i);
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
 */
export function endpointBase(origin) {
  const s = String(origin ?? '').replace(/\/+$/, '');
  // 没有 origin 可用(比如 file:// 打开)时退回本机默认,总比给个空串好
  return `${s || 'http://localhost:9527'}/v1`;
}

/** byModel / byDay 这种 { key: {requests,...} } 映射 -> 按请求数降序的数组 */
export function rankBreakdown(map, limit = 5) {
  return Object.entries(map || {})
    .map(([key, v]) => ({ key, requests: Number(v?.requests) || 0, totalTokens: Number(v?.totalTokens) || 0 }))
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key))
    .slice(0, limit);
}
