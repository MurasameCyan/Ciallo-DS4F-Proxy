/**
 * index.mjs —— 容器入口:面板 + 网关跑在同一个端口。
 *
 * 为什么合一个端口:compose 只用映射一条,用户也只用记一个地址。两套路径的
 * 鉴权本来就不同 —— /v1/* 认 Bearer(给 agent),面板和 /api/* 认会话 cookie
 * 或 Basic(给人和脚本,见 auth.mjs),/health 不认(给 healthcheck)。
 *
 * 监听 0.0.0.0:容器里绑 127.0.0.1 的话端口映射到宿主是通不了的。
 * 这也是 auth.mjs 必须存在的原因。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfgMod from './config.mjs';
import * as mihomo from './mihomo.mjs';
import { Gateway, OPENAI, ANTHROPIC, json } from './gateway.mjs';
import { buildInfo, checkUpdate } from './build.mjs';
import {
  matches, parseBasic, readCookie, resolveCredentials,
  Sessions, FailWindow, SESSION_COOKIE, sessionCookie, CLEAR_COOKIE,
} from './auth.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const MAX_LOG = 500;

// 登录页得在「还没登录」的时候就能显示,所以它自己和它引的两个文件要放行。
// 只放这两条具体路径(/login 单独处理),不是整个 web/ —— 其余静态文件照旧要凭据。
const PUBLIC_FILES = new Set(['/style.css', '/login.js']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── 日志环 + SSE 广播 ──────────────────────────────────

const logs = [];
const clients = new Set();

export function log(level, msg) {
  const line = { ts: new Date().toISOString(), level, msg };
  logs.push(line);
  if (logs.length > MAX_LOG) logs.shift();
  console.log(`[${line.ts}] ${level.padEnd(5)} ${msg}`);
  const frame = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

async function serveStatic(res, path) {
  // 防目录穿越:归一化后必须仍在 WEB 之内
  const rel = normalize(path === '/' ? 'index.html' : path.slice(1)).replace(/^([.][.][/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)) return void res.writeHead(403).end('forbidden');
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * 会话 cookie 该不该带 Secure。反代后面进程这一段是明文的,只看 socket
 * 会漏判 https 部署;而伪造 X-Forwarded-Proto 只能让 cookie 变严,
 * 所以这个头信它没有风险。
 */
function isHttps(req) {
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return fwd === 'https' || req.socket.encrypted === true;
}

// ── 组装 ────────────────────────────────────────────────

/**
 * 建服务但不监听 —— 测试要能在临时端口上把它拉起来,
 * 所以启动副作用(写 mihomo 配置、拉内核)都不放这里。
 */
export function createApp({ cfg, creds, gateway, subscriptionUpdater = null }) {
  const api = makeApiRoutes({ cfg, gateway, subscriptionUpdater });
  const sessions = new Sessions();
  // 登录页和 Basic 共用一个失败计数器 —— 分开的话锁住表单还能拿 Basic 慢慢试
  const guard = new FailWindow();

  /** 脚本那条路:带了 Basic 就验一次,验错记一笔 */
  function basicOk(req) {
    const got = parseBasic(req.headers['authorization']);
    if (!got) return false;                       // 没带就不算一次失败尝试
    if (guard.retryIn()) return false;            // 限速中,连验都不验
    if (matches(creds, got.user, got.pass)) { guard.pass(); return true; }
    log('warn', `[auth] Basic 凭据不对(窗口内第 ${guard.fail()} 次)`);
    return false;
  }

  async function handleLogin(req, res) {
    const wait = guard.retryIn();
    if (wait) {
      const sec = Math.ceil(wait / 1000);
      res.setHeader('Retry-After', String(sec));
      return json(res, { error: `失败次数太多,${sec} 秒后再试` }, 429);
    }
    const b = await readBody(req);
    if (!matches(creds, String(b.user ?? ''), String(b.pass ?? ''))) {
      // 不打提交上来的用户名:那是攻击者能控制的字符串,直接进日志会污染面板
      log('warn', `[auth] 登录失败(窗口内第 ${guard.fail()} 次)`);
      return json(res, { error: '用户名或密码不对' }, 401);
    }
    guard.pass();
    res.setHeader('Set-Cookie', sessionCookie(sessions.issue(), {
      secure: isHttps(req), maxAgeMs: sessions.ttl,
    }));
    log('ok', `[auth] ${creds.user} 已登录`);
    return json(res, { ok: true });
  }

  return createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const send = (p) => void serveStatic(res, p).catch((e) => {
      log('error', `[static] ${p}: ${e.message}`);
      try { res.writeHead(500).end('500'); } catch {}
    });

    // healthcheck 不能要凭据:docker healthcheck 不方便带
    if (path === '/health') {
      // 不再报单一模型名 —— 客户端选什么就转发什么,这里只说清单里有几个
      return json(res, { ok: true, models: gateway.freeModels().length, paused: gateway.paused });
    }

    if (path.startsWith('/v1/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();

      // 连错误体都得说对方言:Anthropic SDK 读不懂 {error:{message}},
      // 它会把畸形响应当成别的问题,把人往错方向带(实测就是这么被坑的)
      const D = path.startsWith('/v1/messages') ? ANTHROPIC : OPENAI;

      if (!gateway.checkKey(req)) return D.fail(res, 401, 'Invalid API key', 'authentication_error');
      if (gateway.paused) {
        res.setHeader('Retry-After', '10');
        return D.fail(res, 503, 'Gateway is restarting, retry shortly', 'gateway_paused');
      }
      if (path === '/v1/models' && req.method === 'GET') return gateway.handleModels(res);

      const run = (p) => void p.catch((e) => {
        log('error', `[${D.name}] 未捕获: ${e.message}`);
        try { D.fail(res, 500, 'Internal: ' + e.message, 'api_error'); } catch {}
      });
      if (path === '/v1/chat/completions' && req.method === 'POST') return run(gateway.handleChat(req, res));
      if (path === '/v1/messages' && req.method === 'POST') return run(gateway.handleMessages(req, res));
      // Claude Code 等客户端开工前会先问一次 token 数,没有这个路由它直接报错退出
      if (path === '/v1/messages/count_tokens' && req.method === 'POST') return run(gateway.handleCountTokens(req, res));

      return D.fail(res, 404, `Not found: ${req.method} ${path}`, 'not_found_error');
    }

    // ── 面板和 /api/*:登录页给的会话 cookie,或脚本自己带的 Basic ──
    // 前端会明文显示 Key 和订阅地址,所以这两样都得挡住。
    // 认不过时刻意不发 WWW-Authenticate —— 那个头就是浏览器弹框的来源(见 auth.mjs)
    //
    // Basic 只认在 /api/* 上,页面一律只认会话 cookie。因为浏览器会把老版本
    // 弹框收到的凭据缓存在 origin 上并一直主动带上:页面也认 Basic 的话,
    // 退出登录之后 /login 又把人 302 回面板,点了像没反应。那份缓存在浏览器
    // 手里,服务端删不掉,只能不让它开门 —— 脚本打 /api/* 不受影响。
    const isApi = path.startsWith('/api/');
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    const authed = sessions.valid(sid) || (isApi && basicOk(req));

    if (path === '/api/login' && req.method === 'POST') {
      return void handleLogin(req, res).catch((e) => {
        log('error', `[auth] 登录处理失败: ${e.message}`);
        try { json(res, { error: e.message }, 500); } catch {}
      });
    }

    if (path === '/api/logout' && req.method === 'POST') {
      if (sid) sessions.drop(sid);              // 服务端当场作废,不只是让浏览器删 cookie
      res.setHeader('Set-Cookie', CLEAR_COOKIE);
      return json(res, { ok: true });
    }

    // 页面路径上只有 GET/HEAD 说得通,POST 到这儿一律 404 JSON。
    //
    // 不能 302 去登录页:HTTP 客户端跟着跳转会拿到 200 + 一坨登录页 HTML,
    // 然后当成上游的回答。实测就被这么坑过 —— cpa 把 base URL 配成不带 /v1 的
    // https://ds4f.yuzu.gv.uy,于是它打的是 /chat/completions,收到 200 + 登录页,
    // 认为调用成功,把 HTML 转给了客户端。404 能让对面当场看出路径错了。
    // /api/* 不在此列:面板自己有一堆 POST(见 makeApiRoutes)。
    if (!isApi && req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, { error: `Not found: ${req.method} ${path}` }, 404);
    }

    if (path === '/login') {
      if (authed) return redirect(res, '/');    // 已经登录了就没必要再看登录页
      return send('/login.html');
    }

    if (!authed) {
      if (PUBLIC_FILES.has(path)) return send(path);
      // 页面请求跳登录页;/api/* 给 401 JSON —— fetch 跟着 302 拿回一坨 HTML,
      // 前端只会报个解析失败,不如让它自己决定跳转(app.js 里就是这么做的)
      if (isApi) return json(res, { error: '未登录' }, 401);
      return redirect(res, '/login');
    }

    if (isApi) {
      api(req, res, path).catch((e) => {
        log('error', `[api] ${path}: ${e.message}`);
        try { json(res, { error: e.message }, 500); } catch {}
      });
      return;
    }
    send(path);
  });
}

/** /api/* 路由。形状与 server/preview.mjs 逐字段对齐,前端一行没改。 */
function makeApiRoutes({ cfg, gateway, subscriptionUpdater }) {
  /** 重启内核期间把网关暂停,请求收 503 重试,而不是打在半死的代理上 */
  async function withPause(fn) {
    gateway.pause();
    try { return await fn(); } finally { gateway.resume(); }
  }

  /**
   * 等一件事,但最多等这么久。测延迟是整组并发,慢在最慢的那个节点身上:
   * 全超时就是探针超时那么久,再加上内核的开销 —— 那样一个 POST 挂在前端上
   * 像卡死。超了就先回,测试在后台跑完,面板下一次轮询 /api/nodes 就看到。
   */
  function atMost(p, ms) {
    let t;
    return Promise.race([
      p.finally(() => clearTimeout(t)),
      new Promise((r) => { t = setTimeout(() => r(null), ms); t.unref?.(); }),
    ]);
  }

  return async function handleApi(req, res, path) {
    const m = req.method;

    if (path === '/api/status' && m === 'GET') {
      const version = await mihomo.getVersion();
      return json(res, {
        gatewayRunning: true,
        gatewayPort: cfg.port,
        mihomoRunning: version !== null,
        mihomoVersion: version,
        paused: gateway.paused,
        // 免费模型清单。从上游现拉(开机一次、之后每天一次),拉不到就是兜底常量 ——
        // 写死在前端的那份已经漏过一个新上线的免费模型
        models: gateway.freeModels(),
        // build / buildUrl / repoUrl / trackRef:面板右上角那个 hash 徽标。
        // 搭轮询的车带过去,不另开一个路由 —— 它是个常量,不值得再来一次请求
        ...buildInfo(),
      });
    }

    // 检查更新只在用户点的时候出站。放在 POST 上和 /api/nodes/test 一致:
    // 它有副作用(会消耗 GitHub 匿名配额),不该被浏览器预取或缓存。
    if (path === '/api/check-update' && m === 'POST') {
      const r = await checkUpdate();
      log(r.error ? 'warn' : 'ok', r.error
        ? `[update] 检查更新失败: ${r.error}`
        : r.hasUpdate
          ? `[update] 有新版本 ${r.latest}(当前 ${r.current}),docker compose pull 后重启`
          : `[update] 已是最新 ${r.current}`);
      return json(res, r);
    }

    if (path === '/api/config' && m === 'GET') {
      return json(res, {
        subscriptionUrl: cfg.subscriptionUrl, apiKey: cfg.apiKey, port: cfg.port,
        opencodeIdentityHeaders: cfg.opencodeIdentityHeaders,
        subscriptionUpdateHours: cfg.subscriptionUpdateHours,
      });
    }

    if (path === '/api/config' && m === 'POST') {
      const b = await readBody(req);
      const hasSubscription = b.subscriptionUrl !== undefined;
      const nextSub = hasSubscription ? String(b.subscriptionUrl).trim() : cfg.subscriptionUrl;
      if (nextSub && !/^https?:\/\//i.test(nextSub)) {
        return json(res, { error: '订阅地址得是 http(s):// 开头' }, 400);
      }
      const subChanged = hasSubscription && nextSub !== cfg.subscriptionUrl;
      const oldHours = cfg.subscriptionUpdateHours;
      let nextHours = oldHours;
      if (b.subscriptionUpdateHours !== undefined) {
        nextHours = Number(b.subscriptionUpdateHours);
        if (!Number.isInteger(nextHours) || nextHours < 0 || nextHours > 8760) {
          return json(res, { error: '自动更新小时数必须是 0 到 8760 的整数' }, 400);
        }
      }

      // 所有字段都验完再修改共享 cfg；否则同一个请求里周期非法、开关合法时，
      // 虽然回了 400，开关却已经悄悄生效。
      cfg.subscriptionUrl = nextSub;
      if (b.opencodeIdentityHeaders !== undefined) {
        cfg.opencodeIdentityHeaders = b.opencodeIdentityHeaders === true;
      }
      cfg.subscriptionUpdateHours = nextHours;

      // 端口刻意不接受修改。容器对外端口由 compose 的 ports 决定,进程改绑
      // 只会让映射指向一个没人听的地方;而 /api/status 会把新值报给前端,
      // 面板于是把接入地址显示成一个连不上的 host:port。前端那个输入框是
      // readonly,但直接 POST 能绕过去,所以这里也得挡。要换端口改 compose。
      cfgMod.save(cfg);
      if (hasSubscription || nextHours !== oldHours) {
        subscriptionUpdater?.schedule(cfg.subscriptionUpdateHours);
      }
      log('info', '[config] 已保存');

      // 「保存」必须真的刷新节点,哪怕地址一个字都没改 —— 机场加减节点、
      // 订阅内容变了但 URL 不变是常态,而按 interval 等下一轮要一小时。
      // 用户点保存的意图就是「现在去拉」,所以两条路都得走到:
      //   地址变了  → 配置文件里的 provider url 变了,必须重启内核才生效
      //   地址没变  → 只需让内核重拉一次,PUT /providers 就够,几百毫秒,
      //               不重启内核也就不会有那几秒 503
      let refreshed = null;
      let speed = null;
      if (hasSubscription && nextSub) {
        if (subChanged) {
          cfgMod.writeMihomoConfig(nextSub);
          log('info', '[sub] 订阅地址已变,重启内核');
          await withPause(async () => {
            gateway.resetCooldowns();
            gateway.forgetLastNode();
            await mihomo.restart(log);
          });
        } else {
          log('info', '[sub] 地址未变,强制重拉订阅');
          try {
            await gateway.updateProvider();
            gateway.resetCooldowns();
          } catch (e) {
            // 内核没起来时 PUT 会失败(比如首次填订阅前内核就没跑)。
            // 那就退回重启这条路,而不是让用户点了保存什么也没发生。
            log('warn', `[sub] 重拉失败(${e.message}),改为重启内核`);
            cfgMod.writeMihomoConfig(nextSub);
            await withPause(async () => {
              gateway.resetCooldowns();
              gateway.forgetLastNode();
              await mihomo.restart(log);
            });
          }
        }
        refreshed = (await gateway.getAllNodes()).length;
        log(refreshed > 0 ? 'ok' : 'warn', `[sub] 刷新完成,${refreshed} 个节点`);
        // 节点表刚换过,旧的延迟数据对不上号了,顺手测一遍:排序 + 剔除不通的
        // 都靠它。这一步不能失败到影响保存本身,所以 catch 掉只记日志。
        if (refreshed > 0) {
          speed = await atMost(
            gateway.testNodes().catch((e) => { log('warn', `[delay] 测延迟失败: ${e.message}`); return null; }),
            20_000);
        }
      }
      return json(res, {
        subscriptionUrl: cfg.subscriptionUrl, apiKey: cfg.apiKey, port: cfg.port,
        opencodeIdentityHeaders: cfg.opencodeIdentityHeaders,
        subscriptionUpdateHours: cfg.subscriptionUpdateHours,
        nodes: refreshed,   // 前端据此提示「刷到了几个节点」,null=没订阅地址
        speed,              // {tested,alive,dead,fastest,ms};null=没测或还没测完
      });
    }

    if (path === '/api/nodes' && m === 'GET') {
      const all = await gateway.getAllNodes();
      return json(res, {
        // 给前端的是排过序的表 —— 网关自己挑节点用的就是这个顺序,
        // 面板显示另一种顺序的话「从上往下就是接下来会用的」这句话就不成立了
        nodes: gateway.rankNodes(all),
        excluded: gateway.excludedNodes(all),
        delay: gateway.delayMap(),
        testedAt: gateway.testedAt || null,
        testing: gateway.testing != null,
        current: await gateway.getCurrentNode(),
        locked: gateway.lockedNode,
        cooldowns: gateway.cooldown.summary(),
      });
    }

    if (path === '/api/nodes/test' && m === 'POST') {
      const r = await gateway.testNodes();
      return json(res, r);
    }

    // 手动同步免费模型清单。平时开机拉一次、之后每天一次(见 MODELS_TTL_MS),
    // 这个按钮是给「上游刚上线了新模型,不想等到明天」用的。放 POST 上和
    // /api/nodes/test 一致:它会出站,不该被 GET 的缓存或预取碰上。
    if (path === '/api/models/sync' && m === 'POST') {
      const r = await gateway.refreshModels();   // 失败会抛,交给下面统一的 500
      return json(res, r);
    }

    if (path === '/api/usage' && m === 'GET') return json(res, gateway.usage.getStats());

    if (path === '/api/usage/reset' && m === 'POST') {
      gateway.usage.reset();
      return json(res, gateway.usage.getStats());
    }

    if (path === '/api/regen-key' && m === 'POST') {
      cfg.apiKey = cfgMod.genApiKey();
      cfgMod.save(cfg);
      // 不用重启进程:gateway 拿的是 cfg 这个对象本身,checkKey 每次现读
      log('info', `[config] 新 Key 已生效: ${cfg.apiKey}`);
      return json(res, { apiKey: cfg.apiKey });
    }

    if (path === '/api/restart' && m === 'POST') {
      log('info', '[mihomo] 手动重启...');
      await withPause(() => mihomo.restart(log));
      return json(res, { ok: true });
    }

    if (path === '/api/reset' && m === 'POST') {
      log('warn', '===== 手动重置开始 =====');
      let cleared = 0;
      await withPause(async () => {
        cleared = gateway.resetCooldowns();
        gateway.forgetLastNode();
        if (cfg.subscriptionUrl) cfgMod.writeMihomoConfig(cfg.subscriptionUrl);
        await mihomo.restart(log);
      });
      log('ok', `[reset] 清空 ${cleared} 个冷却记录`);
      log('ok', '===== 手动重置完成 =====');
      // 内核刚重启,节点表可能变了。后台测一遍,别把重置这个请求拖上十几秒。
      gateway.testNodes().catch((e) => log('warn', `[delay] 重置后测延迟失败: ${e.message}`));
      return json(res, { ok: true, cleared });
    }

    if (path === '/api/logs' && m === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(logs)}\n\n`);   // 首帧:历史快照
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    return json(res, { error: `Not found: ${m} ${path}` }, 404);
  };
}

/**
 * 网关是订阅周期更新的唯一调度源。mihomo provider 的 interval=0，避免同一周期
 * 双重拉取；在这里更新成功后紧接自动测速，保证两件事不会脱钩。
 */
export function createSubscriptionUpdater({
  cfg, gateway, logger = log,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const MAX_TIMER_MS = 2_147_000_000;
  let timer = null;
  let running = null;
  let dueAt = 0;

  const stop = () => {
    if (timer) clearTimer(timer);
    timer = null;
    dueAt = 0;
  };

  const run = async () => {
    if (running) return running;
    running = (async () => {
      try {
        logger('info', '[sub-auto] 开始更新订阅');
        await gateway.updateProvider();
        const nodes = await gateway.getAllNodes();
        logger(nodes.length ? 'ok' : 'warn', `[sub-auto] 更新完成,${nodes.length} 个节点,开始测速`);
        await gateway.testNodes();
      } catch (e) {
        logger('warn', `[sub-auto] 更新失败: ${e.message}`);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  // 等待时间可能超过 setTimeout 上限,那就分段等:被截断的那一段醒来后按
  // 剩余时间重排,只有等满整段才真正触发。判断依据是这一段有没有被截断,而
  // 不是当前时钟 —— 后者在定时器提前醒来时会把一次更新永远推下去。
  const arm = (left) => {
    const slice = Math.min(left, MAX_TIMER_MS);
    timer = setTimer(async () => {
      if (left > slice) return arm(dueAt - Date.now());
      await run();
      schedule(cfg.subscriptionUpdateHours);
    }, slice);
    timer.unref?.();
  };

  const schedule = (hours = cfg.subscriptionUpdateHours) => {
    stop();
    const ms = Number(hours) * 3600_000;
    if (!cfg.subscriptionUrl || !Number.isFinite(ms) || ms <= 0) return;
    dueAt = Date.now() + ms;
    arm(ms);
    logger('info', `[sub-auto] 每 ${hours} 小时自动更新并测速`);
  };

  return { run, schedule, stop };
}

// ── 启动 ────────────────────────────────────────────────

async function main() {
  cfgMod.ensureDirs();
  const cfg = cfgMod.load();
  const creds = resolveCredentials();
  const gateway = new Gateway(cfg, log);
  const subscriptionUpdater = createSubscriptionUpdater({ cfg, gateway });
  const server = createApp({ cfg, creds, gateway, subscriptionUpdater });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '0.0.0.0', resolve);
  });
  log('ok', `[gateway] 监听 0.0.0.0:${cfg.port}`);
  // 开机立刻拉一次清单。不 await:拉取要几秒,这期间面板和 /v1 都该能用
  // —— 没拉到之前用的是 FREE_MODELS 兜底,退化成旧行为而不是失败。
  // 之后每天一次(MODELS_TTL_MS),搭面板轮询的车走,不另起定时器。
  gateway.refreshModels()
    .then((r) => log('info', `[gateway] 免费模型 ${r.models.length} 个,客户端选哪个转发哪个`))
    // 拉不到就用兜底那份跑,refreshModels 已经记过一行 warn 了。
    // 开机失败不该让进程起不来 —— 面板和 /v1 照常可用,过一天自己再拉
    .catch(() => {});

  if (creds.generated) {
    // 打在日志里而不是静默放行。docker logs 看一眼就有,
    // 想固定下来就在 compose 里设 PANEL_PASS。
    log('warn', `[auth] 没设 PANEL_PASS,本次随机生成 —— 用户 ${creds.user} 密码 ${creds.pass}`);
  }

  // 没订阅就先不拉内核:配置文件都写不出来,拉起来只会启动失败刷错误日志。
  // 用户在面板填完订阅,保存那一步会把内核带起来。
  if (cfg.subscriptionUrl) {
    cfgMod.writeMihomoConfig(cfg.subscriptionUrl);
    try {
      await mihomo.start(log);
      const n = (await gateway.getAllNodes()).length;
      log('ok', `[mihomo] 就绪,${n} 个节点`);
      await gateway.restoreLastNode();
      // 开机测一遍延迟。不 await:测完要几秒,而这期间面板和 /v1 都该能用
      // —— 没有延迟数据时 rankNodes 原样返回订阅顺序,退化成旧行为而不是失败。
      if (n > 0) gateway.testNodes().catch((e) => log('warn', `[delay] 开机测延迟失败: ${e.message}`));
    } catch (e) {
      // 不退出:面板还能用,用户得进来改订阅地址。退了就只剩看 docker logs 猜。
      log('error', `[mihomo] 启动失败: ${e.message}`);
    }
  } else {
    log('warn', '[config] 还没有订阅地址 —— 打开面板在「配置」里填,或设 SUBSCRIPTION_URL 环境变量');
  }
  subscriptionUpdater.schedule();

  const bye = async (sig) => {
    log('info', `[exit] 收到 ${sig},收尾中`);
    subscriptionUpdater.stop();
    server.close();
    await mihomo.stop(log);
    process.exit(0);
  };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
}

// 被 import(测试)时不自启。比路径而不是比 URL 字符串:
// Windows 下 file:///S:/... 和 argv[1] 的 S:\... 拼不到一起去。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
}
