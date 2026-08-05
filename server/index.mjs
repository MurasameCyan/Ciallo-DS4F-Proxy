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
import { Gateway, FIXED_MODEL, json } from './gateway.mjs';
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

      if (!gateway.checkKey(req)) return json(res, { error: { message: 'Invalid API key', type: 'auth_error' } }, 401);
      if (gateway.paused) {
        res.setHeader('Retry-After', '10');
        return json(res, { error: { message: 'Gateway is restarting, retry shortly', type: 'gateway_paused' } }, 503);
      }
      if (path === '/v1/models' && req.method === 'GET') return gateway.handleModels(res);
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        return void gateway.handleChat(req, res).catch((e) => {
          log('error', `[chat] 未捕获: ${e.message}`);
          try { json(res, { error: { message: 'Internal: ' + e.message } }, 500); } catch {}
        });
      }
      return json(res, { error: { message: `Not found: ${req.method} ${path}` } }, 404);
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

      if (subChanged && nextSub) {
        cfgMod.writeMihomoConfig(nextSub);
        log('info', '[sub] 订阅已更新,重启内核');
        await withPause(async () => {
          gateway.resetCooldowns();
          gateway.forgetLastNode();
          await mihomo.restart(log);
        });
        const n = (await gateway.getAllNodes()).length;
        log('ok', `[sub] 刷新成功,${n} 个节点`);
      }
      return json(res, { subscriptionUrl: cfg.subscriptionUrl, apiKey: cfg.apiKey, port: cfg.port });
    }

    if (path === '/api/nodes' && m === 'GET') {
      const nodes = await gateway.getAllNodes();
      return json(res, {
        nodes,
        current: await gateway.getCurrentNode(),
        locked: gateway.lockedNode,
        cooldowns: gateway.cooldown.summary(),
      });
    }

    if (path === '/api/usage' && m === 'GET') return json(res, gateway.usage.getStats());

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
