/**
 * auth.mjs —— 面板鉴权。
 *
 * README 里那条约束:面板明文返回 apiKey 和订阅地址(含机场 token),
 * 而容器版必须监听 0.0.0.0(不然端口映射不出去),等于把这两样摆到网上。
 * 所以鉴权是绑 0.0.0.0 的前置条件,不是可选项。
 *
 * 用 HTTP Basic 而不是自己做登录页 + session:浏览器会在 401 后自动带上凭据
 * 并一直复用,连 EventSource('/api/logs') 都不用改 —— 它没法自定义 header,
 * 换成 token 方案反而得为它开后门。
 *
 * 没设密码时随机生成一个并在启动日志里打出来,而不是默认放行:
 * 装完忘了配鉴权,面板就裸奔了。
 */

import crypto from 'node:crypto';

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

export function resolveCredentials(env = process.env) {
  const user = env.PANEL_USER || 'admin';
  if (env.PANEL_PASS) return { user, pass: env.PANEL_PASS, generated: false };
  return { user, pass: crypto.randomBytes(9).toString('base64url'), generated: true };
}

/** 校验一个请求;通过返回 true,否则已写好 401 响应 */
export function checkBasic(req, res, creds) {
  const got = parseBasic(req.headers['authorization']);
  if (got && safeEqual(got.user, creds.user) && safeEqual(got.pass, creds.pass)) return true;

  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Ciallo DS4F Proxy", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('需要面板凭据(PANEL_USER / PANEL_PASS)');
  return false;
}
