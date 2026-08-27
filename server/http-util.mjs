/**
 * http-util.mjs —— 最小的 HTTP 响应helpers。
 *
 * 单独一个文件是为了打断依赖环:方言表(dialects.mjs)要写 JSON 错误体,
 * 而它自己被 gateway.mjs 引用 —— json 留在 gateway.mjs 里就成了环。
 */

/** 写一个 JSON 响应。no-store:面板轮询的接口不能被浏览器或中间层缓存 */
export function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
