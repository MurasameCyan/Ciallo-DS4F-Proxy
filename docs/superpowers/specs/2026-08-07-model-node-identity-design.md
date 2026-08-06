# 模型透传、节点统计与 OpenCode 身份头实验设计

日期：2026-08-07
分支：`beta`

## 目标

在现有零依赖 Node.js 网关上增量实现三项能力：

1. 聊天请求严格透传上游实时免费模型，不再统一改写为 `deepseek-v4-flash-free`。
2. 按每次真实上游尝试统计节点表现，并在面板新增独立“节点统计”卡。
3. 提供可持久化的 OpenCode 身份头实验开关，并统计上游返回的缓存 Token。

本次不引入多 Key、Worker 池、事件账本或新依赖。

## 现状与约束

- `Gateway.freeModels()` 已从 `/zen/v1/models` 获取免费模型并缓存 30 分钟，失败时保留旧清单，冷启动使用 `FREE_MODELS`。
- `OPENAI.toUpstream` 和 `ANTHROPIC.toUpstream` 当前强制写入 `FIXED_MODEL`。
- `UsageTracker` 当前只有客户端请求口径的 `total`、`byDay`、`byModel`。
- 一个客户端请求可能先后尝试多个节点；流式响应写出首字节后不能换节点重试。
- `/data/usage.json` 和 `/data/config.json` 必须向后兼容。
- 面板继续使用现有原生 HTML/CSS/JavaScript，不增加前端依赖。

## 方案

采用增量扩展：保留 `Gateway`、`UsageTracker`、现有路由及页面结构，在现有边界内增加模型校验、节点尝试统计、身份头构造和独立统计卡。

不采用以下方案：

- Worker 抽象：当前没有多上游 Key，重构调度单位会扩大改动面。
- 事件账本：虽然审计能力更强，但会引入持续增长的存储和聚合逻辑。

## 严格模型透传

### 模型来源

请求模型来自客户端请求体顶层 `model`。OpenAI 和 Anthropic 方言转换后都必须保留该值。

### 校验

处理聊天请求时：

1. 验证 `model` 是非空字符串。
2. 取得 `Gateway.freeModels()` 当前同步缓存。
3. 模型不在清单中时立即返回 HTTP 400，不发送上游请求。
4. 模型在清单中时原样写入上游请求体。

OpenAI 路由返回 OpenAI 错误体，错误类型为 `invalid_model`；Anthropic 路由返回合法 Anthropic 错误体，类型映射为 `invalid_request_error`。错误消息包含被拒绝的模型名，但不泄露配置或凭据。

### 清单可用性

- 上游刷新成功：使用最新免费清单。
- 刷新失败：继续使用上次成功清单。
- 尚未成功刷新：使用现有 `FREE_MODELS` 兜底。
- 不因一次模型清单请求失败清空模型列表。

### 响应与统计

- 非流式 Anthropic 响应中的模型名使用实际请求模型。
- Anthropic 流式适配器初始化时使用实际请求模型。
- `/v1/models` 与面板“可用模型”继续来自同一份实时缓存。
- `byModel` 按实际模型记录，不再使用固定模型常量。
- `/health` 不再宣称单一固定模型；移除 `model` 字段，增加 `models` 数字字段，值为当前免费模型清单的数量。

## 两套统计口径

### 客户端请求口径

现有 `total`、`byDay`、`byModel` 保持“一个客户端请求记一次”：

- 最终成功记一次成功，并累计最终响应 usage。
- 所有尝试都失败时记一次失败。
- 中间的 429、超时和节点切换不增加客户端请求总数。

这套口径继续驱动顶部总览卡。

### 节点尝试口径

新增 `byNode`。每次真实发出上游 HTTP 请求记一次节点尝试。节点结果字段：

- `requests`
- `success`
- `rateLimited`
- `timeout`
- `upstreamError`
- `promptTokens`
- `completionTokens`
- `reasoningTokens`
- `totalTokens`
- `cacheReadTokens`
- `cacheWriteTokens`

结果分类互斥：

- HTTP 200 且响应正常完成：`success`
- HTTP 429：`rateLimited`
- 网络错误、CONNECT/TLS 错误或超时：`timeout`
- 其他非 200、响应解析失败或流式开始后的中断：`upstreamError`

流式响应开始后中断时，当前节点记 `upstreamError`，客户端总览记最终失败，不再尝试其他节点。

### Token 与缓存字段

从上游 usage 中兼容读取标准及实际出现的缓存字段。实现时以测试夹具覆盖的字段为准，统一归一化为：

- `cacheReadTokens`
- `cacheWriteTokens`

缺失字段按“无数据”处理。持久化数值可以为 0，但 UI 只有在存在可用统计分母时才显示百分比。

缓存命中率定义为：

`cacheReadTokens / promptTokens`

当 `promptTokens <= 0` 或该节点从未收到缓存统计时显示 `—`，不显示虚假的 `0%`。

### 持久化兼容

加载旧 `usage.json` 时：

- 保留已有 `total`、`byDay`、`byModel`、`lastRequest`、`startTime`。
- 缺少 `byNode` 时补 `{}`。
- 旧统计桶缺少缓存字段时按 0 归一化。
- 不执行破坏性迁移，不重写历史模型名。

“清零统计”重置 `total`、`byDay`、`byModel`、`byNode`、`lastRequest` 和 `startTime`，不修改延迟、冷却、当前节点或配置。

## OpenCode 身份头实验

### 配置

`config.json` 新增布尔字段 `opencodeIdentityHeaders`，默认 `false`。配置读取时对旧文件补默认值；保存时持久化该值。

面板“配置”卡新增标准 toggle：

- 标签：`OpenCode 身份头`
- 关闭状态：`关闭`
- 开启状态：`实验中`
- 与订阅地址一起通过“保存并应用”提交。
- 仅切换该值不重启 mihomo、不刷新订阅，只影响之后的新请求。

### 关闭行为

保持当前出站行为：`User-Agent: node`，不合成 OpenCode 身份头。

### 开启行为

客户端提供的值优先，大小写不敏感地读取并透传：

- `User-Agent`
- `x-opencode-session`
- `x-opencode-request`
- `x-opencode-project`
- `x-opencode-client`
- `x-session-id`
- `x-title`

缺失时补默认值：

- `User-Agent: opencode-cli/1.0.0`
- `x-opencode-client: cli`
- `x-opencode-project: default`
- `x-opencode-request`: 每个客户端请求生成一个 UUID
- `x-opencode-session`: 依次取 `x-opencode-session`、`x-session-affinity`、`x-session-id`；均无值时每个客户端请求生成一个 UUID

请求与会话 ID 在同一客户端请求的节点重试之间必须保持不变。身份头在读取完入站请求后构造一次，再传给所有 `forward`/`forwardStream` 尝试。

本实验只观察身份头是否改善上游缓存 usage；不宣称必然提高命中率，也不改变额度或节点调度规则。

## API 变化

### `GET /api/config`

增加：

```json
{"opencodeIdentityHeaders": false}
```

### `POST /api/config`

可接收：

```json
{"subscriptionUrl":"https://...","opencodeIdentityHeaders":true}
```

字段缺失时保留原值。只有订阅地址变化或用户明确保存订阅时沿用现有刷新逻辑；单独切换身份头不得重启内核。

### `GET /api/usage`

在现有响应上增加 `byNode`，不新增路由。

## 面板设计

新增独立“节点统计”卡，不把统计列塞进现有节点池。

卡片顶部显示节点尝试口径的汇总：

- 总尝试
- 成功
- 429
- 超时
- 上游错误

节点列表：

- 默认按 `requests` 降序，再按节点名排序。
- 只显示至少有一次尝试的节点。
- 每行显示节点名、尝试数、成功率和缓存命中率。
- 展开或次级详情显示 429、超时、上游错误、Token、缓存读写 Token。
- 没有缓存统计时显示 `—`。
- 无节点统计时显示简短空状态，不影响现有节点池。

节点池继续只负责实时运行状态：延迟、当前节点、待用/冷却/不可用以及轮换顺序。两个卡片的职责不混合。

响应式布局沿用现有 grid；桌面作为独立卡片，窄屏自然单列。不得产生横向滚动、嵌套卡片或文本重叠。

## 错误处理

- 无 `model`：400，方言正确的参数错误。
- 模型不在免费清单：400，不回退、不改写、不请求上游。
- 模型清单刷新失败：记录一次警告并继续用旧清单。
- 身份头构造失败：按编程错误处理；UUID 生成使用 Node 标准库，不增加依赖。
- usage 文件读取失败：沿用现有警告与空统计兜底。
- usage 文件写入失败：请求结果不受影响，只记录警告。
- 上游没有缓存 usage：请求仍正常成功，缓存统计显示无数据。

## 测试

### 单元测试

- 免费模型清单校验：允许、拒绝、缺失模型。
- OpenAI 与 Anthropic 转换保留实际模型。
- Anthropic 非流式和流式响应报告实际模型。
- 身份头关闭时保持 `User-Agent: node`。
- 身份头开启时默认补全、客户端值覆盖、大小写不敏感。
- 同一客户端请求跨节点重试时 request/session ID 稳定；不同请求生成不同 request ID。
- usage 缓存字段归一化及命中率的有值、缺失、零分母情况。
- `byNode` 排序和展示数据纯函数。

### 状态机与集成测试

- 节点 A 429、节点 B 成功：客户端总览 1 次成功；A 记录 1 次 429；B 记录 1 次成功。
- 节点 A 连续网络失败后换 B：每次真实 HTTP 尝试按节点记录；客户端总览仅最终记一次。
- 所有节点失败：客户端总览 1 次失败；各节点按真实尝试分类。
- 流式首字节后中断：当前节点 1 次上游错误；总览 1 次失败；不换节点。
- 旧 `usage.json` 与旧 `config.json` 正常加载。
- 配置开关持久化，单独切换不调用 mihomo 重启。
- 清零同时清除 `byNode`。

### 浏览器与布局验证

- 配置 toggle 可键盘操作，状态可由读屏识别。
- 独立节点统计卡的空状态、有数据状态和长节点名。
- 桌面、中等宽度、移动端无横向溢出和重叠。
- 现有登录、登出、节点测速、日志和配置保存流程无回归。

## 文档更新

更新 `beta` 分支 README：

- 客户端模型现在严格透传，仅接受实时免费清单。
- 解释总览“请求数”与节点“尝试数”的口径差异。
- 说明 OpenCode 身份头是实验开关、默认关闭，以及缓存统计依赖上游 usage。
- 更新配置字段、面板说明和持久化文件说明。

## 验收标准

- 客户端选择任一实时免费模型时，上游收到同一模型名，响应及统计显示该模型。
- 非免费或未知模型稳定返回 400，不静默改成其他模型。
- 多节点重试不会膨胀顶部请求总数，但每次上游尝试均归入正确节点和结果类别。
- 身份头开关重启后保持，关闭时请求行为与当前版本一致。
- 开启身份头时同一客户端请求的身份 ID 跨重试稳定。
- 旧数据文件无需手工迁移即可启动。
- 全部自动化测试及三档浏览器布局检查通过。
