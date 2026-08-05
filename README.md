# Ciallo DS4F Proxy

OpenAI 兼容网关。经机场节点出口访问 opencode zen 免费端点,遇 429 自动轮换节点。

免费额度按出口 IP 计,所以轮换出口是这个项目存在的理由。

## 现在能跑什么

UI 已完成,后端接入中。预览用假数据,但 `/api/*` 的形状就是真网关要实现的契约。

```bash
npm run preview   # http://localhost:5173
npm test          # core.js 自检
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
  preview.mjs     预览服务器,零依赖,只监听 127.0.0.1
test/
  check.mjs       core.js 自检,16 组
```

`core.js` 和 `app.js` 分开是为了自检:排序规则、冷却过期、日志裁剪这些容易写错的逻辑
在 `core.js` 里,不需要浏览器就能断言。

## API 契约

面板需要的接口。POST 一律返回 `{ok:true}` 或错误 `{error:"..."}`。

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/status` | `{gatewayRunning, gatewayPort, mihomoRunning, mihomoVersion, fixedModel, paused}` |
| GET | `/api/config` | `{subscriptionUrl, apiKey, port}` |
| POST | `/api/config` | 存配置;订阅或端口变了就重启内核 |
| GET | `/api/nodes` | `{nodes:[名字], current, locked, cooldowns:[{node, remain}]}` — `remain` 单位秒 |
| GET | `/api/usage` | `{total:{requests,success,fail,promptTokens,completionTokens,reasoningTokens,totalTokens}, byDay, byModel, lastRequest, startTime}` |
| POST | `/api/regen-key` | 换 Key 并重启网关 |
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

## 安全

- 面板明文返回 `apiKey` 和订阅地址(含机场 token)。**接真后端时必须加鉴权**,
  否则谁摸到端口就能拿走这两样。预览服务器只监听 `127.0.0.1`
- Key 在界面上默认打掩码,点「显示」才展开;复制按钮永远复制真值,不会把掩码复制出去
- 订阅地址和 Key 落在运行时文件里,已在 `.gitignore` 排除

## 待办

- [ ] `mihomo.js` 移植到 Linux:去掉 `netstat`/`taskkill`,改保住子进程句柄 + SIGTERM
- [ ] `config.js` 换 Linux 内核路径,geo 文件不再从 Clash Verge 目录拷
- [ ] `gateway.js` 监听改 `0.0.0.0`(容器里 `127.0.0.1` 映射不出来),并补 `/api/*`
- [ ] 面板鉴权
- [ ] Dockerfile + compose,订阅地址走 env/mount 注入,不打进镜像
