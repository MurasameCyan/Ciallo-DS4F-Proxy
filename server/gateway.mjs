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
import { MihomoAgent } from './proxy.mjs';
import { LAST_NODE_FILE, USAGE_FILE, MIXED_PORT, CTRL_PORT, POOL_NAME } from './config.mjs';

const OPENCODE_HOST = 'opencode.ai';
const CHAT_PATH = '/zen/v1/chat/completions';
export const FIXED_MODEL = 'deepseek-v4-flash-free';
export const COOLDOWN_MS = 90 * 1000;

export const FREE_MODELS = [
  'deepseek-v4-flash-free',
  'big-pickle',
  'mimo-v2.5-free',
  'laguna-s-2.1-free',
  'ling-3.0-flash-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blankTotals = () => ({
  requests: 0, success: 0, fail: 0,
  promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
});

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
        if (d?.total) return d;
      }
    } catch (e) { this.logger?.('warn', `[usage] 读取失败: ${e.message}`); }
    return { total: blankTotals(), byDay: {}, byModel: {}, lastRequest: null, startTime: Date.now() };
  }
  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) { this.logger?.('warn', `[usage] 保存失败: ${e.message}`); }
  }
  record(model, usage, success) {
    const day = new Date().toISOString().slice(0, 10);
    const pt = usage?.prompt_tokens || 0;
    const ct = usage?.completion_tokens || 0;
    const rt = usage?.completion_tokens_details?.reasoning_tokens || 0;
    const tt = usage?.total_tokens || pt + ct;

    this.data.byDay[day] ??= blankTotals();
    this.data.byModel[model] ??= blankTotals();
    for (const b of [this.data.total, this.data.byDay[day], this.data.byModel[model]]) {
      b.requests++;
      if (success) b.success++; else b.fail++;
      b.promptTokens += pt;
      b.completionTokens += ct;
      b.reasoningTokens += rt;
      b.totalTokens += tt;
    }
    this.data.lastRequest = Date.now();
    this.save();
  }
  getStats() { return this.data; }
  reset() {
    this.data = { total: blankTotals(), byDay: {}, byModel: {}, lastRequest: null, startTime: Date.now() };
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
    this.lockedNode = null;     // 成功后锁定,后续请求直接用,直到 429
    this.switching = false;
    this.paused = false;        // 重启/重置期间置位,请求收 503 而不是打到坏代理上
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

  checkKey(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
    return !!m && m[1] === this.config.apiKey;
  }

  handleModels(res) {
    json(res, {
      object: 'list',
      data: FREE_MODELS.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'opencode-zen' })),
    });
  }

  async handleChat(req, res) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8e6) return json(res, { error: { message: 'Request too large' } }, 413);
    }
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, { error: { message: 'Invalid JSON' } }, 400); }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(res, { error: { message: 'messages required' } }, 400);
    }
    body.model = FIXED_MODEL;    // 固定模型,忽略客户端传的
    const wantStream = body.stream === true;

    const nodes = await this.getAllNodes();
    if (nodes.length === 0) {
      return json(res, { error: { message: '没有可用节点 —— 检查订阅地址和 mihomo 状态', type: 'no_nodes' } }, 503);
    }
    const cur = await this.ensureNode(nodes, res);
    if (!cur) return;   // ensureNode 已经回过错误了
    return this.attempt(res, body, nodes, cur, wantStream);
  }

  /** 选定本次要用的节点并让 mihomo 切过去;返回节点名,失败返回 null(已响应) */
  async ensureNode(nodes, res) {
    let cur = this.lockedNode;
    if (cur && !this.cooldown.isCooling(cur) && nodes.includes(cur)) return cur;

    cur = this.cooldown.pickAvailable(nodes);
    if (!cur) {
      // 全员冷却:等剩余最短的那个恢复,而不是直接失败
      const s = this.cooldown.soonest(nodes);
      if (s && s.remain > 0) {
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
      json(res, { error: { message: 'Switch node failed' } }, 503);
      return null;
    }
    return cur;
  }
  /** 重试循环:429 换节点,网络错误只重试当前节点(换了也是白换,避免振荡) */
  async attempt(res, body, nodes, cur, wantStream) {
    const tried = new Set();
    const MAX_NET_RETRY = 2;
    let netRetry = 0;

    for (let i = 0; i <= nodes.length + 5; i++) {
      const t0 = Date.now();
      try {
        const result = wantStream ? await this.forwardStream(res, body) : await this.forward(body);

        const dt = Date.now() - t0;
        this.lockedNode = cur;
        this.cooldown.clear(cur);
        this.saveLastNode(cur);
        if (wantStream) {
          // 流式的 usage 在 forwardStream 里边转发边记,这儿没有 result
          this.logger('ok', `[stream-ok] node="${cur}" ${dt}ms`);
          return;
        }
        this.usage.record(FIXED_MODEL, result.usage, true);
        this.logger('ok', `[ok] node="${cur}" ${dt}ms tokens=${result.usage?.total_tokens ?? '?'}`);
        return json(res, result);
      } catch (e) {
        const status = e.status || 0;

        // 流已经开始吐了就不能重试:头都发出去了,换节点等于给客户端拼接两半响应
        if (e.notStarted === false) {
          this.logger('error', `[stream-mid] node="${cur}" 中断: ${e.body || e.message}`);
          try { res.end(); } catch {}
          return;
        }

        if (status === 429) {
          this.cooldown.mark429(cur);
          this.usage.record(FIXED_MODEL, null, false);
          this.logger('warn', `[429] node="${cur}" 限流,冷却 ${COOLDOWN_MS / 1000}s`);
          tried.add(cur);
          netRetry = 0;

          const next = this.cooldown.pickAvailable(nodes, tried);
          if (!next) {
            const s = this.cooldown.summary();
            this.logger('error', `[chat] 全部节点冷却中: ${s.length} 个`);
            return json(res, {
              error: {
                message: `All nodes rate-limited, retry in ~${s[0]?.remain || 90}s`,
                type: 'all_nodes_429', cooldown: s,
              },
            }, 429);
          }
          // 换之前喘 2 秒:重置后一口气把所有节点扫成 429 就是这么来的,
          // 上游限流是按窗口算的,给它一点恢复时间
          await sleep(2000);
          if (await this.switchNode(next)) cur = next;
          else tried.add(next);
          continue;
        }

        if (status === 0) {
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
            this.usage.record(FIXED_MODEL, null, false);
            return json(res, { error: { message: 'All nodes timeout' } }, 504);
          }
          if (await this.switchNode(next)) cur = next;
          else tried.add(next);
          continue;
        }

        // 400/500 之类:换节点也是同样结果,直接把上游的话原样带回去
        this.usage.record(FIXED_MODEL, null, false);
        this.logger('error', `[chat] HTTP ${status}: ${String(e.body).slice(0, 300)}`);
        let payload;
        try { payload = JSON.parse(e.body); } catch { payload = { error: { message: `HTTP ${status}` } }; }
        return json(res, payload, status);
      }
    }
    this.usage.record(FIXED_MODEL, null, false);
    this.logger('error', '[chat] 重试次数耗尽');
    return json(res, { error: { message: 'All nodes unavailable after retries', type: 'all_nodes_unavailable' } }, 503);
  }
  // ── 出站 ──────────────────────────────────────────────

  /**
   * 两个 forward 共用的请求选项。
   *
   * 不带 Authorization + User-Agent: node 是刻意的 —— zen 免费端点就认这个形态,
   * 补上 Bearer 反而 401。额度按出口 IP 算,所以换 IP 才是有意义的动作。
   */
  reqOpts(bodyStr, { accept, timeout }) {
    return {
      host: OPENCODE_HOST,
      port: 443,
      path: CHAT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        'User-Agent': 'node',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      agent: this.agent,     // ← 真正经 mihomo 出站的地方
      timeout,
    };
  }

  forward(body) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify({ ...body, stream: false });
      const r = https.request(this.reqOpts(bodyStr, { accept: '*/*', timeout: 60_000 }), (resp) => {
        let data = '';
        resp.on('data', (c) => (data += c));
        resp.on('end', () => {
          if (resp.statusCode !== 200) return reject({ status: resp.statusCode, body: data });
          try { resolve(JSON.parse(data)); } catch { reject({ status: 502, body: data }); }
        });
      });
      r.on('error', (e) => reject({ status: 0, body: e.message }));
      r.on('timeout', () => { r.destroy(); reject({ status: 0, body: 'timeout' }); });
      r.end(bodyStr);
    });
  }

  /** SSE 原样透传,顺路把最后那帧的 usage 抄下来记账 */
  forwardStream(res, body) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify({ ...body, stream: true });
      const r = https.request(this.reqOpts(bodyStr, { accept: 'text/event-stream', timeout: 120_000 }), (resp) => {
        if (resp.statusCode !== 200) {
          // 还没 writeHead,可以安全重试:收完 body 让上层判是 429 还是别的
          let data = '';
          resp.on('data', (c) => (data += c));
          resp.on('end', () => reject({ status: resp.statusCode, body: data, notStarted: true }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        let buf = '';
        let usage = null;
        resp.on('data', (chunk) => {
          res.write(chunk);           // 先转发,统计是副产品,别让它拖慢流
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
        resp.on('end', () => {
          res.end();
          if (usage) this.usage.record(FIXED_MODEL, usage, true);
          resolve();
        });
        resp.on('error', (e) => {
          this.logger('error', `[stream] 中断: ${e.message}`);
          try { res.end(); } catch {}
          resolve();     // 已经发出去一部分了,不算失败
        });
      });
      r.on('error', (e) => reject({ status: 0, body: e.message, notStarted: true }));
      r.on('timeout', () => { r.destroy(); reject({ status: 0, body: 'stream timeout', notStarted: true }); });
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

  mihomoApi(p, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: CTRL_PORT, path: p, method, timeout: 10_000,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      }, (resp) => {
        let data = '';
        resp.on('data', (c) => (data += c));
        resp.on('end', () => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new Error(`HTTP ${resp.statusCode}`));
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
