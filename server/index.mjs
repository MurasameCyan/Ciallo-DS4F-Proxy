/**
 * index.mjs —— 容器入口:面板 + 网关跑在同一个端口。
 *
 * 为什么合一个端口:compose 只用映射一条,用户也只用记一个地址。两套路径的
 * 鉴权本来就不同 —— /v1/* 认 Bearer(给 agent),/api/* 和面板认 Basic(给人),
 * /health 不认(给 healthcheck)。
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
import { Gateway, FIXED_MODEL, OPENAI, ANTHROPIC, json } from './gateway.mjs';
import { checkBasic, resolveCredentials } from './auth.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const MAX_LOG = 500;

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

// ── 组装 ────────────────────────────────────────────────

/**
 * 建服务但不监听 —— 测试要能在临时端口上把它拉起来,
 * 所以启动副作用(写 mihomo 配置、拉内核)都不放这里。
 */
export function createApp({ cfg, creds, gateway }) {
  const api = makeApiRoutes({ cfg, gateway });

  return createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;

    // healthcheck 不能要凭据:docker healthcheck 不方便带
    if (path === '/health') {
      return json(res, { ok: true, model: FIXED_MODEL, paused: gateway.paused });
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

    // 面板和 /api/* 都要 Basic —— 前端会明文显示 Key 和订阅地址
    if (!checkBasic(req, res, creds)) return;

    if (path.startsWith('/api/')) {
      api(req, res, path).catch((e) => {
        log('error', `[api] ${path}: ${e.message}`);
        try { json(res, { error: e.message }, 500); } catch {}
      });
      return;
    }
    serveStatic(res, path).catch((e) => {
      log('error', `[static] ${path}: ${e.message}`);
      try { res.writeHead(500).end('500'); } catch {}
    });
  });
}

/** /api/* 路由。形状与 server/preview.mjs 逐字段对齐,前端一行没改。 */
function makeApiRoutes({ cfg, gateway }) {
  /** 重启内核期间把网关暂停,请求收 503 重试,而不是打在半死的代理上 */
  async function withPause(fn) {
    gateway.pause();
    try { return await fn(); } finally { gateway.resume(); }
  }

  /**
   * 等一件事,但最多等这么久。测速是「测完 N 个节点」,17 个节点全超时要 15s,
   * 上百个节点的订阅能到一分半 —— 那样一个 POST 会挂在前端上像卡死。
   * 超了就先回,测速在后台继续跑完,面板下一次轮询 /api/nodes 就看到结果。
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
        fixedModel: FIXED_MODEL,
        paused: gateway.paused,
      });
    }

    if (path === '/api/config' && m === 'GET') {
      return json(res, { subscriptionUrl: cfg.subscriptionUrl, apiKey: cfg.apiKey, port: cfg.port });
    }

    if (path === '/api/config' && m === 'POST') {
      const b = await readBody(req);
      const nextSub = b.subscriptionUrl === undefined ? cfg.subscriptionUrl : String(b.subscriptionUrl).trim();
      if (nextSub && !/^https?:\/\//i.test(nextSub)) {
        return json(res, { error: '订阅地址得是 http(s):// 开头' }, 400);
      }
      const subChanged = nextSub !== cfg.subscriptionUrl;
      cfg.subscriptionUrl = nextSub;

      // 端口刻意不接受修改。容器对外端口由 compose 的 ports 决定,进程改绑
      // 只会让映射指向一个没人听的地方;而 /api/status 会把新值报给前端,
      // 面板于是把接入地址显示成一个连不上的 host:port。前端那个输入框是
      // readonly,但直接 POST 能绕过去,所以这里也得挡。要换端口改 compose。
      cfgMod.save(cfg);
      log('info', '[config] 已保存');

      // 「保存」必须真的刷新节点,哪怕地址一个字都没改 —— 机场加减节点、
      // 订阅内容变了但 URL 不变是常态,而按 interval 等下一轮要一小时。
      // 用户点保存的意图就是「现在去拉」,所以两条路都得走到:
      //   地址变了  → 配置文件里的 provider url 变了,必须重启内核才生效
      //   地址没变  → 只需让内核重拉一次,PUT /providers 就够,几百毫秒,
      //               不重启内核也就不会有那几秒 503
      let refreshed = null;
      let speed = null;
      if (nextSub) {
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
            gateway.testNodes().catch((e) => { log('warn', `[speed] 测速失败: ${e.message}`); return null; }),
            20_000);
        }
      }
      return json(res, {
        subscriptionUrl: cfg.subscriptionUrl, apiKey: cfg.apiKey, port: cfg.port,
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
      gateway.testNodes().catch((e) => log('warn', `[speed] 重置后测速失败: ${e.message}`));
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
// ── 启动 ────────────────────────────────────────────────

async function main() {
  cfgMod.ensureDirs();
  const cfg = cfgMod.load();
  const creds = resolveCredentials();
  const gateway = new Gateway(cfg, log);
  const server = createApp({ cfg, creds, gateway });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '0.0.0.0', resolve);
  });
  log('ok', `[gateway] 监听 0.0.0.0:${cfg.port}`);
  log('info', `[gateway] Model: ${FIXED_MODEL} (固定)`);

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
      // 开机测一遍延迟。不 await:测完要十几秒,而这期间面板和 /v1 都该能用
      // —— 没有延迟数据时 rankNodes 原样返回订阅顺序,退化成旧行为而不是失败。
      if (n > 0) gateway.testNodes().catch((e) => log('warn', `[speed] 开机测速失败: ${e.message}`));
    } catch (e) {
      // 不退出:面板还能用,用户得进来改订阅地址。退了就只剩看 docker logs 猜。
      log('error', `[mihomo] 启动失败: ${e.message}`);
    }
  } else {
    log('warn', '[config] 还没有订阅地址 —— 打开面板在「配置」里填,或设 SUBSCRIPTION_URL 环境变量');
  }

  const bye = async (sig) => {
    log('info', `[exit] 收到 ${sig},收尾中`);
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
