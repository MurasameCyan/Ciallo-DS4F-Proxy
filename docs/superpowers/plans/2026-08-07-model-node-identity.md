# 模型透传、节点统计与身份头实验实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 严格透传上游实时免费模型，按每次上游尝试统计节点表现，并提供可持久化的 OpenCode 身份头实验开关和独立节点统计卡。

**架构：** 保留现有 `Gateway`、`UsageTracker`、配置 API 和原生面板，在请求进入时校验模型，在每次真实上游尝试结束时记录节点结果，在客户端请求结束时维持原有总览口径。身份头由独立纯函数构造一次并跨节点重试复用，面板通过现有 `/api/config` 与 `/api/usage` 展示和控制。

**技术栈：** Node.js 20 ESM、内置 `http`/`https`/`crypto`/`fs`、原生 HTML/CSS/JavaScript、`assert/strict` 自检脚本、现有无依赖测试与截图审计。

---

## 文件结构

- 创建：`server/opencode-headers.mjs` —— 只负责大小写不敏感读取入站头、生成并构造可复用的上游身份头。
- 修改：`server/config.mjs` —— 持久化 `opencodeIdentityHeaders`，兼容旧配置文件。
- 修改：`server/gateway.mjs` —— 严格模型校验、实际模型响应、两套统计口径、节点尝试结果和缓存 Token 归一化。
- 修改：`server/index.mjs` —— 配置 API 新字段、保存时区分订阅变更与单纯身份头切换、`/health` 模型数量。
- 修改：`server/anthropic.mjs` —— 保持请求模型并由调用方把实际模型传给 Anthropic 响应转换。
- 修改：`web/core.js` —— 节点统计排序、汇总和缓存命中率纯函数。
- 修改：`web/app.js` —— 读取/提交身份头开关并渲染独立节点统计卡。
- 修改：`web/index.html` —— 配置 toggle 与独立“节点统计”卡语义结构。
- 修改：`web/style.css` —— toggle、统计汇总、节点统计行及响应式样式。
- 修改：`server/preview.mjs` —— 补齐新配置和 `byNode` 预览数据，使浏览器验证可见。
- 修改：`test/server.mjs` —— 配置、模型校验、身份头、UsageTracker 和重试统计测试。
- 修改：`test/anthropic.mjs` —— Anthropic 模型透传与实际模型响应测试。
- 修改：`test/check.mjs` —— 节点统计展示纯函数测试。
- 修改：`test/e2e.mjs` —— 路由级严格模型、配置与统计口径回归。
- 修改：`README.md`、`.env.example` —— 模型行为、统计口径、实验开关和配置说明。

## 任务 1：配置与身份头纯函数

**文件：**
- 创建：`server/opencode-headers.mjs`
- 修改：`server/config.mjs:31-72`
- 测试：`test/server.mjs`

- [ ] **步骤 1：编写配置兼容与身份头失败测试**

在 `test/server.mjs` 增加以下导入和测试。测试应使用临时 `config.json`，并直接调用纯函数：

```js
const { buildIdentityHeaders } = await import('../server/opencode-headers.mjs');

await t('旧配置缺少身份头字段时默认关闭', () => {
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    subscriptionUrl: 'https://sub.example/a', apiKey: 'zen-test', port: 9527,
  }));
  assert.equal(load().opencodeIdentityHeaders, false);
});

await t('身份头关闭时保持 node UA 且不合成 OpenCode 头', () => {
  assert.deepEqual(buildIdentityHeaders({}, false), { 'User-Agent': 'node' });
});

await t('身份头开启时客户端值优先并合成缺失字段', () => {
  const h = buildIdentityHeaders({
    'user-agent': 'client/2',
    'X-OpenCode-Project': 'p1',
    'x-session-affinity': 'session-a',
  }, true, () => 'uuid-1');
  assert.equal(h['User-Agent'], 'client/2');
  assert.equal(h['x-opencode-project'], 'p1');
  assert.equal(h['x-opencode-session'], 'session-a');
  assert.equal(h['x-opencode-request'], 'uuid-1');
  assert.equal(h['x-opencode-client'], 'cli');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/server.mjs`

预期：FAIL，提示找不到 `server/opencode-headers.mjs` 或 `opencodeIdentityHeaders` 为 `undefined`。

- [ ] **步骤 3：实现身份头纯函数**

创建 `server/opencode-headers.mjs`，使用 `node:crypto` 的 `randomUUID`，接口固定为：

```js
import { randomUUID } from 'node:crypto';

const get = (headers, name) => {
  const found = Object.entries(headers || {})
    .find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] == null ? '' : String(found[1]);
};

export function buildIdentityHeaders(clientHeaders, enabled, uuid = randomUUID) {
  if (!enabled) return { 'User-Agent': 'node' };
  const out = {
    'User-Agent': get(clientHeaders, 'user-agent') || 'opencode-cli/1.0.0',
    'x-opencode-client': get(clientHeaders, 'x-opencode-client') || 'cli',
    'x-opencode-project': get(clientHeaders, 'x-opencode-project') || 'default',
    'x-opencode-request': get(clientHeaders, 'x-opencode-request') || uuid(),
    'x-opencode-session': get(clientHeaders, 'x-opencode-session')
      || get(clientHeaders, 'x-session-affinity')
      || get(clientHeaders, 'x-session-id')
      || uuid(),
  };
  for (const name of ['x-session-id', 'x-title']) {
    const value = get(clientHeaders, name);
    if (value) out[name] = value;
  }
  return out;
}
```

- [ ] **步骤 4：扩展配置默认值与保存字段**

在 `server/config.mjs` 将默认值和保存解构改为：

```js
const DEFAULTS = {
  subscriptionUrl: '', apiKey: '', port: 9527,
  opencodeIdentityHeaders: false,
};

export function save(cfg) {
  ensureDirs();
  const {
    subscriptionUrl = '', apiKey = '', port = 9527,
    opencodeIdentityHeaders = false,
  } = cfg;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    subscriptionUrl, apiKey, port,
    opencodeIdentityHeaders: opencodeIdentityHeaders === true,
  }, null, 2), 'utf8');
}
```

在 `load()` 返回前强制规范化：

```js
cfg.opencodeIdentityHeaders = cfg.opencodeIdentityHeaders === true;
```

- [ ] **步骤 5：运行后端测试确认通过**

运行：`node test/server.mjs`

预期：新增三项通过，原有测试全部通过。

- [ ] **步骤 6：Commit**

```bash
git add server/opencode-headers.mjs server/config.mjs test/server.mjs
git commit -m "feat(配置): 添加 OpenCode 身份头实验开关"
```

## 任务 2：严格模型透传与实际模型响应

**文件：**
- 修改：`server/gateway.mjs:21-142,327-455,497-603,629-742`
- 修改：`server/anthropic.mjs:163-220`
- 测试：`test/server.mjs`
- 测试：`test/anthropic.mjs`

- [ ] **步骤 1：编写模型校验与响应模型失败测试**

在 `test/server.mjs` 增加：

```js
await t('模型必须存在于当前免费清单', () => {
  const g = new Gateway(load(), () => {});
  g.models = ['m-free'];
  assert.equal(g.validateModel('m-free'), null);
  assert.match(g.validateModel('paid-model'), /paid-model/);
  assert.match(g.validateModel(''), /model/);
});
```

在 `test/anthropic.mjs` 增加：

```js
t('Anthropic 请求模型原样进入 OpenAI 请求', () => {
  const r = anthropicToOpenAI({ model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.model, 'mimo-v2.5-free');
});

t('Anthropic 非流式响应使用实际请求模型', () => {
  const r = openAIToAnthropic({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }, 'mimo-v2.5-free');
  assert.equal(r.model, 'mimo-v2.5-free');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/server.mjs && node test/anthropic.mjs`

预期：`validateModel is not a function`，并暴露固定模型改写相关断言失败。

- [ ] **步骤 3：让方言转换保留请求模型**

将方言对象改为：

```js
export const OPENAI = {
  name: 'openai',
  toUpstream: (body) => ({ ...body }),
  validate: (b) => (Array.isArray(b.messages) && b.messages.length ? null : 'messages required'),
  // 其余成员保持不变
};

export const ANTHROPIC = {
  name: 'anthropic',
  toUpstream: (body) => anthropicToOpenAI(body),
  // fail/validate 保持不变；respond/sink 改为由调用点传 model
};
```

不要把实际模型保存在方言单例中；并发请求会互相覆盖。修改调用点，让 `attempt` 接收 `model` 并调用：

```js
return dialect.respond(res, result, model);
// 流式：dialect.sink(res, model)
```

`ANTHROPIC.respond` 和 `ANTHROPIC.sink` 使用传入模型；OpenAI 仍原样返回上游响应。

- [ ] **步骤 4：实现同步模型校验并接入请求入口**

在 `Gateway` 增加：

```js
validateModel(raw) {
  const model = typeof raw === 'string' ? raw.trim() : '';
  if (!model) return 'model required';
  if (!this.freeModels().includes(model)) return `Model is not available on the free endpoint: ${model}`;
  return null;
}
```

在 `handleChat` 完成方言基础校验后、获取节点前执行：

```js
const modelError = this.validateModel(inbound.model);
if (modelError) return dialect.fail(res, 400, modelError, 'invalid_model');
const model = inbound.model.trim();
const body = dialect.toUpstream({ ...inbound, model });
```

将 `model` 传入 `attempt`、`forwardStream` 的 sink 和最终请求级统计。删除聊天链路中对 `FIXED_MODEL` 的使用；保留常量只供向后兼容测试时也应最终删除所有运行时引用。

- [ ] **步骤 5：修正 `/health` 和启动日志**

在 `server/index.mjs` 中把：

```js
{ ok: true, model: FIXED_MODEL, paused: gateway.paused }
```

改为：

```js
{ ok: true, models: gateway.freeModels().length, paused: gateway.paused }
```

启动日志改为记录免费模型数量，不再宣称固定模型。

- [ ] **步骤 6：运行模型相关测试**

运行：`node test/anthropic.mjs && node test/server.mjs`

预期：全部通过；搜索运行时固定模型引用：

```bash
rg "FIXED_MODEL" server test
```

预期：聊天转发和统计路径无引用；若常量已无使用者，删除导出和对应导入。

- [ ] **步骤 7：Commit**

```bash
git add server/gateway.mjs server/anthropic.mjs server/index.mjs test/server.mjs test/anthropic.mjs
git commit -m "feat(网关): 严格透传实时免费模型"
```

## 任务 3：两套统计口径与节点尝试分类

**文件：**
- 修改：`server/gateway.mjs:172-274,430-603,629-742`
- 测试：`test/server.mjs`

- [ ] **步骤 1：编写旧数据兼容与节点桶失败测试**

在 `test/server.mjs` 增加：

```js
await t('旧 usage 文件加载后补 byNode 和缓存字段', () => {
  const f = path.join(TMP, 'usage-old.json');
  fs.writeFileSync(f, JSON.stringify({
    total: { requests: 2, success: 1, fail: 1 },
    byDay: {}, byModel: {}, lastRequest: null, startTime: 1,
  }));
  const d = new UsageTracker(f, () => {}).getStats();
  assert.deepEqual(d.byNode, {});
  assert.equal(d.total.cacheReadTokens, 0);
  assert.equal(d.total.cacheWriteTokens, 0);
});

await t('节点尝试和客户端请求使用不同计数口径', () => {
  const f = path.join(TMP, 'usage-node.json');
  const u = new UsageTracker(f, () => {});
  u.recordAttempt('A', 'm-free', 'rateLimited');
  u.recordAttempt('B', 'm-free', 'success', {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  u.recordRequest('m-free', {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  }, true);
  const d = u.getStats();
  assert.equal(d.total.requests, 1);
  assert.equal(d.byNode.A.requests, 1);
  assert.equal(d.byNode.A.rateLimited, 1);
  assert.equal(d.byNode.B.success, 1);
  assert.equal(d.byNode.B.cacheReadTokens, 40);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/server.mjs`

预期：FAIL，提示 `recordAttempt`/`recordRequest` 不存在。

- [ ] **步骤 3：重构 UsageTracker 为两个明确入口**

把统计桶扩展为：

```js
const blankTotals = () => ({
  requests: 0, success: 0, fail: 0,
  promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0,
});

const blankNode = () => ({
  requests: 0, success: 0, rateLimited: 0, timeout: 0, upstreamError: 0,
  promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0,
  hasCacheData: false,
});
```

实现固定接口：

```js
recordRequest(model, usage, success) { /* 原 record 逻辑，只更新 total/byDay/byModel */ }
recordAttempt(node, model, outcome, usage = null) { /* 只更新 byNode[node] */ }
```

缓存字段读取集中到一个内部函数，至少兼容：

```js
const cacheRead = usage?.prompt_tokens_details?.cached_tokens
  ?? usage?.cache_read_input_tokens
  ?? 0;
const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
```

`load()` 对每个旧桶与空桶合并默认字段，而不是只判断 `d.total` 后原样返回。

- [ ] **步骤 4：在每次真实上游尝试结束点记节点结果**

在 `attempt` 中使用实际节点 `cur` 和模型 `model`：

```js
// 非流式成功
this.usage.recordAttempt(cur, model, 'success', result.usage);
this.usage.recordRequest(model, result.usage, true);

// 429
this.usage.recordAttempt(cur, model, 'rateLimited');

// status === 0
this.usage.recordAttempt(cur, model, 'timeout');

// 其他 HTTP/解析错误
this.usage.recordAttempt(cur, model, 'upstreamError');
```

每个 `https.request` 只记录一次结果。网络重试会实际发新请求，因此每次都记录一次 `timeout`。客户端级 `recordRequest(..., false)` 只能在整个请求最终结束的出口调用一次，不能在每个 429 上调用。

- [ ] **步骤 5：让流式转发返回 usage 与完成状态**

将 `forwardStream` 成功 resolve 值固定为：

```js
{ usage, completed: true }
```

流开始后中断固定为：

```js
{ usage, completed: false }
```

`attempt` 收到后：

```js
this.usage.recordAttempt(cur, model,
  result.completed ? 'success' : 'upstreamError', result.usage);
this.usage.recordRequest(model, result.usage, result.completed);
```

流开始前的 429/网络错误仍通过 reject 进入现有换节点逻辑，并按对应尝试分类。

- [ ] **步骤 6：扩展 reset 测试并运行**

在原 reset 测试增加：

```js
assert.deepEqual(d.byNode, {});
```

运行：`node test/server.mjs`

预期：全部通过，并确认一次 A 429、B 成功的夹具中 `total.requests === 1`、两个节点各一条尝试。

- [ ] **步骤 7：Commit**

```bash
git add server/gateway.mjs test/server.mjs
git commit -m "feat(统计): 按上游尝试记录节点表现"
```

## 任务 4：身份头接入请求链与配置 API

**文件：**
- 修改：`server/gateway.mjs:430-455,606-627`
- 修改：`server/index.mjs:250-349`
- 测试：`test/server.mjs`
- 测试：`test/e2e.mjs`

- [ ] **步骤 1：编写跨重试头稳定性与配置 API 失败测试**

构造假的 `forward` 或截获 `reqOpts`，断言同一个 `handleChat` 的多次尝试拿到同一组 ID：

```js
await t('同一客户端请求跨节点重试复用身份 ID', () => {
  const g = new Gateway({ ...load(), opencodeIdentityHeaders: true }, () => {});
  const identity = g.identityHeaders({ 'x-session-id': 's1' });
  const a = g.reqOpts('{}', { accept: '*/*', timeout: 1000, identity });
  const b = g.reqOpts('{}', { accept: '*/*', timeout: 1000, identity });
  assert.equal(a.headers['x-opencode-request'], b.headers['x-opencode-request']);
  assert.equal(a.headers['x-opencode-session'], 's1');
});
```

路由测试增加 `GET /api/config` 返回布尔值、`POST /api/config` 单独切换时不触发内核重启的断言。

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/server.mjs && node test/e2e.mjs`

预期：FAIL，提示 `identityHeaders` 不存在或配置响应缺字段。

- [ ] **步骤 3：在读取入站请求后构造一次身份头**

在 `Gateway` 导入并包装：

```js
import { buildIdentityHeaders } from './opencode-headers.mjs';

identityHeaders(headers) {
  return buildIdentityHeaders(headers, this.config.opencodeIdentityHeaders === true);
}
```

`handleChat` 在读完请求体后执行一次：

```js
const identity = this.identityHeaders(req.headers);
```

将 `identity` 传入 `attempt`、`forward`、`forwardStream` 和 `reqOpts`。`reqOpts` 合并顺序为基础协议头在前、身份头在后，但禁止身份头覆盖 `Content-Type`、`Accept` 和 `Content-Length`：

```js
headers: {
  ...identity,
  'Content-Type': 'application/json',
  Accept: accept,
  'Content-Length': Buffer.byteLength(bodyStr),
}
```

- [ ] **步骤 4：扩展配置 API 并避免无关重启**

`GET /api/config` 返回 `opencodeIdentityHeaders`。`POST` 读取：

```js
const nextIdentity = b.opencodeIdentityHeaders === undefined
  ? cfg.opencodeIdentityHeaders
  : b.opencodeIdentityHeaders === true;
const identityChanged = nextIdentity !== cfg.opencodeIdentityHeaders;
cfg.opencodeIdentityHeaders = nextIdentity;
```

保留现有“用户保存订阅就刷新订阅”的行为，但只有请求体实际带有 `subscriptionUrl` 时才执行订阅刷新分支。只提交开关时保存配置后立即返回，不调用 `updateProvider`、`restart` 或 `testNodes`。

- [ ] **步骤 5：运行后端与 e2e 测试**

运行：`node test/server.mjs && node test/e2e.mjs`

预期：全部通过；身份头关闭测试仍得到 `User-Agent: node`。

- [ ] **步骤 6：Commit**

```bash
git add server/gateway.mjs server/index.mjs test/server.mjs test/e2e.mjs
git commit -m "feat(网关): 接入 OpenCode 身份头实验"
```

## 任务 5：节点统计展示纯逻辑

**文件：**
- 修改：`web/core.js:179-196`
- 测试：`test/check.mjs`

- [ ] **步骤 1：编写节点统计排序与命中率失败测试**

在 `test/check.mjs` 导入 `nodeUsageRows`、`nodeUsageSummary`、`cacheHitRate` 并增加：

```js
t('节点统计按尝试数降序且忽略零尝试', () => {
  const rows = nodeUsageRows({
    A: { requests: 2, success: 1, promptTokens: 100, cacheReadTokens: 20, hasCacheData: true },
    B: { requests: 5, success: 4, promptTokens: 0, cacheReadTokens: 0, hasCacheData: false },
    C: { requests: 0 },
  });
  assert.deepEqual(rows.map((x) => x.name), ['B', 'A']);
  assert.equal(rows[0].successRate, 0.8);
  assert.equal(rows[0].cacheHitRate, null);
  assert.equal(rows[1].cacheHitRate, 0.2);
});

t('节点统计汇总保留各结果分类', () => {
  assert.deepEqual(nodeUsageSummary({
    A: { requests: 3, success: 1, rateLimited: 1, timeout: 1, upstreamError: 0 },
    B: { requests: 2, success: 1, rateLimited: 0, timeout: 0, upstreamError: 1 },
  }), { requests: 5, success: 2, rateLimited: 1, timeout: 1, upstreamError: 1 });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/check.mjs`

预期：FAIL，提示导出不存在。

- [ ] **步骤 3：实现展示纯函数**

在 `web/core.js` 增加：

```js
export function cacheHitRate(v) {
  if (!v?.hasCacheData) return null;
  const prompt = Number(v.promptTokens) || 0;
  if (prompt <= 0) return null;
  return (Number(v.cacheReadTokens) || 0) / prompt;
}

export function nodeUsageRows(map) {
  return Object.entries(map || {})
    .map(([name, v]) => ({
      name,
      ...v,
      requests: Number(v?.requests) || 0,
      successRate: successRate(v),
      cacheHitRate: cacheHitRate(v),
    }))
    .filter((v) => v.requests > 0)
    .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
}

export function nodeUsageSummary(map) {
  const out = { requests: 0, success: 0, rateLimited: 0, timeout: 0, upstreamError: 0 };
  for (const v of Object.values(map || {})) {
    for (const k of Object.keys(out)) out[k] += Number(v?.[k]) || 0;
  }
  return out;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node test/check.mjs`

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add web/core.js test/check.mjs
git commit -m "feat(面板): 添加节点统计展示逻辑"
```

## 任务 6：配置 toggle 与独立节点统计卡

**文件：**
- 修改：`web/index.html:114-177`
- 修改：`web/app.js:8-27,76-172,224-249,358-381`
- 修改：`web/style.css:254-374`
- 修改：`server/preview.mjs`
- 测试：`test/check.mjs`

- [ ] **步骤 1：在预览数据中加入新字段**

`server/preview.mjs` 的配置响应加入：

```js
opencodeIdentityHeaders: true
```

usage 响应加入至少三个节点夹具，覆盖成功、429、超时、缓存有值和无值：

```js
byNode: {
  '🇫🇮FI_1|1.4MB/s': {
    requests: 41, success: 38, rateLimited: 2, timeout: 1, upstreamError: 0,
    promptTokens: 100000, completionTokens: 22000, reasoningTokens: 9000,
    totalTokens: 122000, cacheReadTokens: 31000, cacheWriteTokens: 8000,
    hasCacheData: true,
  },
  '🇯🇵JP_2': {
    requests: 19, success: 15, rateLimited: 2, timeout: 1, upstreamError: 1,
    promptTokens: 60000, completionTokens: 12000, reasoningTokens: 3000,
    totalTokens: 72000, cacheReadTokens: 0, cacheWriteTokens: 0,
    hasCacheData: false,
  },
}
```

- [ ] **步骤 2：添加语义化 toggle 与统计卡 HTML**

在配置表单中加入：

```html
<label class="switch-row" for="f-identity">
  <span>OpenCode 身份头</span>
  <span class="switch-state" id="identity-state">关闭</span>
  <input type="checkbox" id="f-identity">
  <span class="switch" aria-hidden="true"></span>
</label>
```

新增独立卡片：

```html
<section class="card fill node-usage-card" aria-labelledby="h-node-usage">
  <div class="card-head">
    <h2 id="h-node-usage">节点统计</h2>
    <span class="hint">按上游尝试</span>
  </div>
  <div class="node-usage-summary" id="node-usage-summary"></div>
  <ul class="node-usage" id="node-usage"></ul>
  <p class="empty" id="node-usage-empty" hidden>还没有节点尝试记录。</p>
</section>
```

统计行使用 `<details>`/`<summary>`，不手写展开状态机，键盘和读屏行为由浏览器提供。

- [ ] **步骤 3：实现渲染与提交绑定**

在 `web/app.js` 导入新纯函数，增加：

```js
function renderIdentity() {
  const on = S.cfg.opencodeIdentityHeaders === true;
  if (document.activeElement !== $('f-identity')) $('f-identity').checked = on;
  $('identity-state').textContent = on ? '实验中' : '关闭';
}

function renderNodeUsage() {
  const map = S.usage?.byNode || {};
  const rows = nodeUsageRows(map);
  const total = nodeUsageSummary(map);
  $('node-usage-empty').hidden = rows.length > 0;
  // summary 生成 5 个固定指标；rows 生成 details/summary 和详情字段。
  // 所有数字通过 textContent 写入，不拼用户可控 HTML。
}
```

提交体改为：

```js
body: JSON.stringify({
  subscriptionUrl: url,
  opencodeIdentityHeaders: $('f-identity').checked,
})
```

checkbox `change` 时只更新旁边状态文案，不立即提交。

- [ ] **步骤 4：添加稳定尺寸与响应式 CSS**

样式必须包含：

```css
.switch-row { display:flex; align-items:center; gap:10px; margin:13px 0; font-size:12px; color:var(--fg-2); }
.switch-row .switch-state { margin-left:auto; }
.switch-row input { position:absolute; opacity:0; pointer-events:none; }
.switch { width:36px; height:20px; border:1px solid var(--line-2); border-radius:10px; background:var(--bg); position:relative; }
.switch::after { content:""; position:absolute; width:14px; height:14px; left:2px; top:2px; border-radius:50%; background:var(--fg-2); transition:transform .13s, background .13s; }
.switch-row input:checked + .switch::after { transform:translateX(16px); background:var(--mint); }
.switch-row input:focus-visible + .switch { outline:2px solid var(--mint); outline-offset:2px; }
.node-usage-summary { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:7px; }
.node-usage { display:grid; gap:7px; overflow-y:auto; min-height:0; }
@media (max-width: 720px) { .node-usage-summary { grid-template-columns:repeat(2,minmax(0,1fr)); } }
```

沿用现有色板和 `var(--r-sm)`；不增加新卡片嵌套。

- [ ] **步骤 5：运行预览并执行布局审计**

运行：

```bash
npm run preview
node scripts/shot.mjs
```

预期：桌面、中等宽度、移动端均无横向溢出、文本重叠或空白卡；toggle 可通过 Tab 聚焦和 Space 切换；节点长名称省略但 `title`/展开内容可读。

- [ ] **步骤 6：运行前端纯逻辑测试**

运行：`node test/check.mjs`

预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add web/index.html web/app.js web/style.css web/core.js server/preview.mjs test/check.mjs
git commit -m "feat(面板): 展示独立节点统计卡"
```

## 任务 7：路由级回归与文档

**文件：**
- 修改：`test/e2e.mjs`
- 修改：`test/server.mjs`
- 修改：`README.md`
- 修改：`.env.example`

- [ ] **步骤 1：补全路由级验收测试**

在 `test/e2e.mjs` 使用假的 Gateway/上游夹具覆盖：

```js
// 1. POST /v1/chat/completions model=mimo-v2.5-free，断言上游 body.model 相同。
// 2. model=paid-model 返回 400，断言上游调用次数仍为 0。
// 3. POST /v1/messages 的 400 错误体 type=error、error.type=invalid_request_error。
// 4. GET /health 返回数字 models，不再返回 model。
// 5. GET /api/usage 返回 byNode。
// 6. POST /api/usage/reset 后 byNode 为空。
```

测试名称必须直接表达行为，例如：

```js
await t('未知模型返回 400 且不触碰上游', async () => {
  let calls = 0;
  gateway.models = ['mimo-v2.5-free'];
  gateway.forward = async () => { calls++; return {}; };
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'paid-model', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 400);
  assert.equal(calls, 0);
  assert.match((await r.json()).error.message, /paid-model/);
});
```

具体测试应复用 `test/e2e.mjs` 已有的临时服务启动变量名；若该文件使用不同的 `base`/`gateway` 变量名，只替换变量名，不改变断言语义。

- [ ] **步骤 2：运行完整测试确认实现缺口**

运行：`npm test`

预期：check、anthropic、server、e2e 四组全部通过。失败时按测试指向的模块修正实现，并保留上述严格模型与“不触碰上游”断言。

- [ ] **步骤 3：更新 README 与环境变量示例**

README 明确写入：

```md
- `/v1/models` 和面板模型清单来自上游实时免费清单（缓存 30 分钟）。
- 聊天请求严格使用客户端指定模型；未知或非免费模型返回 400，不再静默改写。
- 顶部请求总数按客户端请求统计；节点统计按真实上游尝试统计，因此一次请求换节点时后者会增加多次。
- OpenCode 身份头实验默认关闭，可在配置卡开启；它只影响新请求，不重启 mihomo。
- 缓存命中率依赖上游 usage 返回缓存 Token；无数据时显示 `—`。
```

配置和数据卷章节增加 `opencodeIdentityHeaders` 与 `usage.json.byNode`。`.env.example` 不新增身份头环境变量，因为设计已明确仅由面板持久化控制。

- [ ] **步骤 4：运行最终验证**

运行：

```bash
npm test
node scripts/shot.mjs
```

预期：check、anthropic、server、e2e 全部通过；三档布局审计无溢出。

- [ ] **步骤 5：检查工作区和变更范围**

运行：

```bash
git status --short
git diff --check
git diff --stat
```

预期：只有本计划列出的源码、测试和文档文件；`.superpowers/` 视觉伴侣目录不加入提交。

- [ ] **步骤 6：Commit**

```bash
git add README.md .env.example test/e2e.mjs test/server.mjs
git commit -m "docs(网关): 说明模型透传与节点统计"
```

## 任务 8：实现后审查与交付

**文件：**
- 审查：本计划涉及的全部文件

- [ ] **步骤 1：运行简化审查**

调用 `simplify` 技能，重点检查：

- 客户端请求统计是否只在最终出口记录一次。
- 节点尝试是否每个真实 HTTP 请求恰好记录一次。
- OpenAI 与 Anthropic 是否共用模型和统计逻辑。
- 身份头是否只构造一次并跨重试复用。
- 前端是否通过纯函数复用汇总逻辑。

- [ ] **步骤 2：运行代码审查**

调用 `review` 技能，重点验证流式首字节后中断、并发请求、旧数据兼容和配置保存副作用。若有确认问题，先修复并补回归测试。

- [ ] **步骤 3：重新运行所有验证**

运行：

```bash
npm test
node scripts/shot.mjs
git diff --check
```

预期：全部通过且无空白错误输出。

- [ ] **步骤 4：提交审查修正**

仅在审查产生代码变化时执行：

```bash
git add server web test README.md .env.example
git commit -m "fix(网关): 修正模型与节点统计边界"
```

- [ ] **步骤 5：推送前确认**

本计划不自动推送。向用户汇报提交列表、测试结果和布局结果；只有用户明确要求推送时才执行：

```bash
git push origin beta
```
