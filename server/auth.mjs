/**
 * auth.mjs —— 面板鉴权。
 *
 * README 里那条约束:面板明文返回 apiKey 和订阅地址(含机场 token),
 * 而容器版必须监听 0.0.0.0(不然端口映射不出去),等于把这两样摆到网上。
 * 所以鉴权是绑 0.0.0.0 的前置条件,不是可选项。
 *
 * 两条路进来,同一份凭据:
 *   人   → /login 页面 POST 一次,拿一个 HttpOnly 会话 cookie
 *   脚本 → 照旧直接带 Authorization: Basic(README 里那些 /api/* 的用法)
 *
 * Basic 只在 /api/* 上认,页面一律只认 cookie:浏览器会把弹框那次收到的凭据
 * 缓存在 origin 上并一直主动带上,页面也认的话「退出登录」就退不掉(见 index.mjs)。
 *
 * 原来只有 Basic 一条路,靠浏览器自己弹框收凭据。那个弹框是 401 响应里的
 * WWW-Authenticate 头带出来的 —— 样式不可控、错了给不出自己的提示、
 * 退出登录只能靠关浏览器。所以现在一律不发这个头,浏览器就不再弹框,
 * 登录改成面板自己的页面。
 *
 * 会话放 cookie 而不是 localStorage + 自定义头:EventSource('/api/logs')
 * 加不了 header,但同源请求会自动带 cookie —— 日志流那条路一行都不用改。
 *
 * 没设密码时随机生成一个并在启动日志里打出来,而不是默认放行:
 * 装完忘了配鉴权,面板就裸奔了。
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'ciallo_sid';
const SESSION_TTL_MS = 12 * 3600_000;

/** 定长比较,避免逐字符提前返回泄漏前缀信息 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // 先摘要再比:crypto.timingSafeEqual 长度不等会直接抛,而长度本身不是秘密
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(x).digest(),
    crypto.createHash('sha256').update(y).digest(),
  );
}

/** 解析 Authorization: Basic base64(user:pass);拿不到返回 null */
export function parseBasic(header) {
  const m = /^Basic\s+(\S+)$/i.exec(header || '');
  if (!m) return null;
  let text;
  try { text = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return null; }
  const i = text.indexOf(':');
  if (i === -1) return null;
  return { user: text.slice(0, i), pass: text.slice(i + 1) };
}

/**
 * 用户名 + 密码都得对。两个都算完再 && —— 短路会让「用户名错」比「密码错」
 * 早返回一点,那点时间差就是在告诉爆破者用户名已经猜对了。
 */
export function matches(creds, user, pass) {
  // 凭据本身是空的就一律不过:那时 '' === '' 会变成「空账号空密码放行」,
  // 是最糟的失败方向。resolveCredentials 不会给出空密码,这里是兜底
  if (!creds?.user || !creds?.pass) return false;
  const u = safeEqual(user, creds.user);
  const p = safeEqual(pass, creds.pass);
  return u && p;
}

export function resolveCredentials(env = process.env) {
  const user = env.PANEL_USER || 'admin';
  if (env.PANEL_PASS) return { user, pass: env.PANEL_PASS, generated: false };
  return { user, pass: crypto.randomBytes(9).toString('base64url'), generated: true };
}

/** 从 Cookie 头里取一个值(`a=1; b=2` 那套格式);没有就返回空串 */
export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;                       // `flag` 这种没等号的段落跳过
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/**
 * 会话表。id 用随机数而不是签名 token —— 服务端记着才能做到「退出登录当场
 * 失效」,签名 token 想撤销还得另维护一张黑名单,反而更多。
 *
 * ponytail: 存在进程内存里,容器重启就得重新登录一次(一天一次的量级)。
 *   要免掉就得落盘或引入签名密钥管理,不值得。
 */
export class Sessions {
  constructor(ttlMs = SESSION_TTL_MS) { this.ttl = ttlMs; this.live = new Map(); }

  issue(now = Date.now()) {
    // 顺手扫掉过期项。只在登录时扫:表本来就只有几条,不值得挂个定时器
    for (const [id, exp] of this.live) if (exp <= now) this.live.delete(id);
    const id = crypto.randomBytes(24).toString('base64url');
    this.live.set(id, now + this.ttl);
    return id;
  }

  valid(id, now = Date.now()) {
    if (!id) return false;
    const exp = this.live.get(id);
    if (exp === undefined) return false;
    if (exp <= now) { this.live.delete(id); return false; }
    return true;
  }

  drop(id) { return this.live.delete(id); }
}

/** 会话 cookie 的 Set-Cookie 值 */
export function sessionCookie(id, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  // HttpOnly:面板自己的脚本也读不到,XSS 偷不走
  // SameSite=Lax:跨站 POST 不带 cookie(有副作用的路由全是 POST),
  //   但从别处点链接进来仍是登录态
  // Secure 只在真走 https 时加 —— 本地 http://127.0.0.1:9527 上加了浏览器直接丢弃
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`
    + (secure ? '; Secure' : '');
}

/** 退出登录:同名空值 + Max-Age=0,让浏览器把它删掉 */
export const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * 凭据校验的失败限速。
 *
 * 不按 IP 分桶:反代后面 socket IP 全是同一个,分桶等于没分;而信
 * X-Forwarded-For 又能被伪造着绕过去。密码只有一个,谁在试都一样。
 *
 * 只有「校验失败」才计数,成功立刻清零;已登录的会话根本不走这条路 ——
 * 所以有人在外面爆破时,你手上那张 cookie 不会被连带挡住。
 *
 * ponytail: 计数在内存里,重启即清空。窗口取 1 分钟而不是更长:代价是
 *   「有人一直灌错密码时,新的登录尝试也要等窗口过完」,60 秒可以接受,
 *   而 10 次/分钟对爆破已经压到每小时 600 次。
 */
export class FailWindow {
  constructor(max = 10, windowMs = 60_000) { this.max = max; this.win = windowMs; this.hits = []; }

  /** 0 = 还能试;>0 = 还得等的毫秒数 */
  retryIn(now = Date.now()) {
    while (this.hits.length && now - this.hits[0] >= this.win) this.hits.shift();
    return this.hits.length >= this.max ? this.win - (now - this.hits[0]) : 0;
  }

  /** 记一次失败,返回窗口内累计次数(拿去打日志) */
  fail(now = Date.now()) { this.retryIn(now); this.hits.push(now); return this.hits.length; }

  pass() { this.hits.length = 0; }
}
