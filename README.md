# Ciallo DS4F Proxy

OpenAI 兼容网关。经机场节点出口访问 opencode zen 免费端点,遇 429 自动轮换节点。

免费额度按出口 IP 计,所以轮换出口是这个项目存在的理由。

## 跑起来

镜像由 GitHub Actions 构建好推到 GHCR,**不用自己 build**。拿 `docker-compose.yml`
和 `.env.example` 两个文件就够了:

```bash
cp .env.example .env     # 填 PANEL_PASS 和 SUBSCRIPTION_URL
docker compose up -d
```

- 面板 <http://127.0.0.1:9527> — Basic 认证,用 `.env` 里那对凭据
- 接口 <http://127.0.0.1:9527/v1> — OpenAI 兼容,Bearer 用面板里显示的 Key

```bash
docker compose pull && docker compose up -d    # 升级
docker compose logs -f                          # 看日志
```

订阅地址留空也能起来,进面板在「配置」里填,保存那一步会把内核带起来。

模型固定 `deepseek-v4-flash-free`,客户端传什么都会被覆盖。接上就能用:

```bash
curl http://127.0.0.1:9527/v1/chat/completions \
  -H "Authorization: Bearer <面板里的 Key>" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

## 本地开发

```bash
npm run preview   # http://localhost:5173 —— 假数据,只看 UI
npm start         # 真网关,需要 DATA_DIR 和 mihomo 内核
npm test          # 自检 45 组
```

预览里的数据会自己动:每 3 秒模拟一次请求,约 12% 触发 429 → 节点进 90 秒冷却 → 自动切换。
冷却倒计时、日志自动滚动、级别过滤这些跟时间有关的交互都能真的验证到。

## 结构

```
web/
  index.html      页面结构
  style.css       视觉层(深色为主,跟随系统切浅色)
  core.js         纯展示逻辑,不碰 DOM —— 自检直接 import 它
  app.js          DOM 绑定:轮询 + SSE + 交互
server/
  index.mjs       容器入口:面板 + 网关同一个端口,监听 0.0.0.0
  gateway.mjs     OpenAI 兼容转发 + 节点轮换状态机 + 用量统计
  proxy.mjs       经 mihomo 出站的 HTTPS 通道(CONNECT 隧道)
  mihomo.mjs      内核进程管理(SIGTERM,不用 netstat/taskkill)
  config.mjs      运行时配置 + mihomo 配置生成
  auth.mjs        面板 Basic 鉴权
  preview.mjs     预览服务器,假数据,只监听 127.0.0.1
test/
  check.mjs       core.js 自检,16 组
  server.mjs      后端自检,29 组
```

整个项目零 npm 依赖 —— 订阅解析交给 mihomo 的 `proxy-providers`,所以连 `js-yaml` 都不需要。

`core.js` 和 `app.js` 分开是为了自检:排序规则、冷却过期、日志裁剪这些容易写错的逻辑
在 `core.js` 里,不需要浏览器就能断言。

## 出站为什么单独一个文件

`desktop-app/gateway.js` 里有这么两处:

```js
agent: new https.Agent({ proxy: `http://127.0.0.1:17897` })
```

`https.Agent` 没有 `proxy` 这个选项。键被存进对象里,Agent 实现从没读过它 ——
所有"经节点出站"的请求实际都是直连,mihomo 被完全绕过。429 换节点换了也没用,
出口 IP 一直是本机。**桌面版的轮换从来没生效过。**

`proxy.mjs` 自己走 HTTP CONNECT 把这件事做对:先让 mihomo 把 TCP 打到目标,
再在隧道之上做 TLS。两个 caller(流式 / 非流式)共用这一份实现。
`keepAlive` 必须关 —— 复用旧隧道等于还挂在旧节点的出口 IP 上。

## API 契约

面板需要的接口。POST 一律返回 `{ok:true}` 或错误 `{error:"..."}`。

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/status` | `{gatewayRunning, gatewayPort, mihomoRunning, mihomoVersion, fixedModel, paused}` |
| GET | `/api/config` | `{subscriptionUrl, apiKey, port}` |
| POST | `/api/config` | 存配置;订阅变了就重拉 + 重启内核。`port` 只存不生效(见待办) |
| GET | `/api/nodes` | `{nodes:[名字], current, locked, cooldowns:[{node, remain}]}` — `remain` 单位秒 |
| GET | `/api/usage` | `{total:{requests,success,fail,promptTokens,completionTokens,reasoningTokens,totalTokens}, byDay, byModel, lastRequest, startTime}` |
| POST | `/api/regen-key` | 换 Key,当场生效(旧 Key 立刻失效,不用重启) |
| POST | `/api/restart` | 重启内核 |
| POST | `/api/reset` | 清冷却 + 重拉订阅 + 重启内核 |
| GET | `/api/logs` | SSE。首帧是历史数组,之后每帧一条 `{ts, level, msg}` |

字段刻意对齐 `zen-proxy-source/desktop-app` 现有的 IPC 返回值,移植时不用改前端。

## 节点列表的顺序是有意义的

从上往下就是网关接下来会用的顺序:

1. **在用** — 当前节点。一个能用就一直用,不主动换
2. **待用** — 保持订阅原序,因为网关取第一个不冷却的
3. **冷却** — 剩余时间短的靠前,对应「全部冷却时选剩余最短的」

当前节点自己正在冷却时会标成「冷却」而不是「在用」—— 它那会儿其实不可用。

## 镜像

`.github/workflows/docker.yml`:push 到 `main` 出 `latest`,打 `v*` 标签出版本号,
PR 只构建不推。`linux/amd64` + `linux/arm64`,推 `ghcr.io/murasamecyan/ciallo-ds4f-proxy`。
用 `GITHUB_TOKEN` 的 `packages: write`,不用另配 secret。

mihomo 内核在构建时按 `TARGETARCH` 下载(`v1.19.29`),不入库。amd64 取
`-compatible` 那个包:普通 amd64 包会用较新的 CPU 指令集,老机器和一些虚拟化
平台上直接 illegal instruction。

推完会拉起容器验一遍:`/health` 通、`/api/*` 匿名访问返回 401、带凭据能读到状态。

## 安全

- 面板明文返回 `apiKey` 和订阅地址(含机场 token)。容器必须监听 `0.0.0.0`
  (不然端口映射不出去),所以 **Basic 鉴权是绑 `0.0.0.0` 的前置条件**。
  没设 `PANEL_PASS` 时每次启动随机生成一个并打在日志里,而不是默认放行
- compose 默认只绑 `127.0.0.1:9527`。改成 `9527:9527` 会把面板一起暴露到局域网,
  那种情况下 `PANEL_PASS` 必须是强密码
- `/v1/*` 认 Bearer(给 agent),`/api/*` 和面板认 Basic(给人),`/health` 不认
  (给 healthcheck)。换 Key 后旧 Key 当场失效,不用等重启
- Key 在界面上默认打掩码,点「显示」才展开;复制按钮永远复制真值,不会把掩码复制出去
- 订阅地址和 Key 只在运行时卷(`/data`)里,`.dockerignore` 挡住它们被 COPY 进镜像层,
  `.gitignore` 挡住入库

## 已验证 / 未验证

后端在没有 Docker 的机器上写的,所以分清楚哪些是真跑过的:

**跑过:** `npm test` 45 组(冷却状态机、用量统计、配置生成、鉴权、CONNECT 协议、
真 server 在临时端口上的路由与鉴权);配置文件过了真内核 `mihomo -t`,并用本地假订阅
验了 `proxy-providers` 拉取、`PUT /proxies/zen-pool` 切节点(含 emoji 节点名)、
`PUT /providers/proxies/airport` 强制刷订阅;TLS-over-CONNECT 用自签证书验了 SNI、
证书校验未被关掉、3 个请求开 3 条隧道(没复用)。

**没跑过:** `docker build` 和 `docker compose up` —— 本机没有 Docker。Dockerfile 和
workflow 是审读 + CI 里那步「拉起容器验一遍」来兜。第一次 push 后请看 Actions 的结果。

**还没接过真机场:** 上游 429 的实际行为、90 秒冷却够不够,都要拿真订阅跑才知道。

## 待办

- [x] `mihomo.js` 移植到 Linux:去掉 `netstat`/`taskkill`,改保住子进程句柄 + SIGTERM
- [x] `config.js` 换 Linux 内核路径,geo 文件不再从 Clash Verge 目录拷
      (改用 `proxy-providers`,并去掉 DNS `fallback` —— 它会把 MMDB 下载拖进启动路径)
- [x] `gateway.js` 监听改 `0.0.0.0`,并补 `/api/*`
- [x] 面板鉴权
- [x] Dockerfile + compose,订阅地址走 env/mount 注入,不打进镜像
- [ ] 拿真机场订阅跑一轮,确认 429 → 换节点 → 恢复这条链在真流量下的表现
- [x] `/api/config` 的 `port` 改成不可改(容器里对外端口由 compose 映射决定),
      前端标 readonly,服务端也挡 —— 不然面板会显示一个连不上的接入地址
