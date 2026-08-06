# Ciallo DS4F Proxy

把 [opencode zen](https://opencode.ai) 的免费模型包成一个本地网关,同时讲 **OpenAI** 和 **Anthropic** 两种协议。

出口走你自己的机场节点(内置 mihomo 解析订阅),撞到 429 自动换下一个节点 —— 因为免费额度是**按出口 IP 计**的,换 IP 就等于换额度池。

```
你的 agent ──▶ 本网关 ──▶ mihomo ──▶ 机场节点 ──▶ opencode.ai
   OpenAI /                            ▲
   Anthropic                       429 就换一个
```

> **代码在 [`beta`](https://github.com/MurasameCyan/Ciallo-DS4F-Proxy/tree/beta) 分支。**
> `main` 只放这份说明。镜像由 `beta` 的推送构建,标签仍然是 `:latest`,所以 compose 不用改。

---

## 拉起来

不需要自己 build,镜像 GitHub Actions 已经推到 GHCR(amd64 + arm64)。

```bash
curl -O https://raw.githubusercontent.com/MurasameCyan/Ciallo-DS4F-Proxy/beta/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/MurasameCyan/Ciallo-DS4F-Proxy/beta/.env.example

# 编辑 .env,至少把 PANEL_PASS 填上
docker compose up -d
```

打开 <http://127.0.0.1:9527>,用 `.env` 里的凭据登录,在「配置」页填机场订阅地址、保存。节点会当场刷新,不用重启容器。

面板上那个 Key 就是接口 Key,复制走给 agent 用。

**升级:** `docker compose pull && docker compose up -d`

### .env

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PANEL_PASS` | ✅ | 面板密码。面板会**明文显示** API Key 和订阅地址(里面有机场 token),别用弱密码 |
| `PANEL_USER` | | 默认 `admin` |
| `SUBSCRIPTION_URL` | | 机场订阅(Clash/mihomo 格式)。只在首次启动播种,之后以面板里改的为准 |
| `API_KEY` | | 留空则首次启动自动生成,面板里可查可换 |

compose 默认只绑 `127.0.0.1:9527`。想让同网段其它机器连,把端口改成 `"9527:9527"` —— 那等于把面板一起暴露到局域网,`PANEL_PASS` 必须是强密码。

---

## 接上你的工具

Base URL 就是面板首页显示的那个(它取的是你当前的访问地址 + `/v1`,反代/端口映射后面也对)。

### OpenAI 协议

```bash
curl http://127.0.0.1:9527/v1/chat/completions \
  -H "Authorization: Bearer <你的 Key>" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

Cherry Studio / Chatbox / LobeChat / 任何填得了 Base URL 的客户端,照常填 `http://127.0.0.1:9527/v1` + Key。

### Anthropic 协议(Claude Code、Cline)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:9527
export ANTHROPIC_AUTH_TOKEN=<你的 Key>
claude
```

`Authorization: Bearer` 和 `x-api-key` 两个头都认 —— Anthropic 的 SDK 只发后者,只认 Bearer 的话客户端会收到 401,然后把它显示成「模型不存在或你没有权限」,排查方向直接被带偏。

### 路由表

| 路由 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI | 流式/非流式都支持,流式原样透传 |
| `POST /v1/messages` | Anthropic | 非流式转形状,流式实时翻译成 Messages 事件 |
| `POST /v1/messages/count_tokens` | Anthropic | 估算值。缺这个路由 Claude Code 开工前就退出了 |
| `GET /v1/models` | 两者 | |
| `GET /health` | | 不需要鉴权,给探针用 |

错误体按路由前缀分方言:`/v1/messages` 出 `{"type":"error","error":{"type":...}}`,其余出 OpenAI 的 `{"error":{...}}`。SDK 读的就是这个字段,给错形状它会当成解析失败。

---

## 它替你处理的事

**429 轮换。** 免费额度按出口 IP 计。撞到 429 就把当前节点冷却 90 秒、换下一个重发,对客户端是透明的。最多换 6 个节点 —— 48 个全试一遍没意义,同一个机场的出口经常是同一段 IP。

**超时预算。** 一个请求从进来到回复上限 75 秒,剩不到 8 秒就不再开新尝试,直接回 504。不这么管的话,轮换会把单个请求拖到客户端自己超时,报出来的错和真实原因完全对不上。

**流开始后不重试。** 头一旦发出去,响应就定型了;这时候再换节点重发等于把两半响应拼给客户端。所以 `writeHead` 之后的任何失败都只做收尾 —— Anthropic 那边会补一个合法的 `error` + `message_stop`,客户端不会挂到超时。

**工具调用参数增量。** 流式的 tool 参数用 `input_json_delta` 一段段发。参考实现里是在第一个分片就 start+stop,长参数会被截断。

---

## 面板

| 页 | 内容 |
| --- | --- |
| 概览 | Base URL、Key、当前节点、内核状态 |
| 配置 | 订阅地址、换 Key、重启内核、重置 |
| 节点 | 节点列表、延迟、冷却中的会标出来 |
| 用量 | 按天/按模型的调用数和 token |
| 日志 | 内核和网关的实时日志 |

订阅地址改完点保存**当场生效**:地址变了就重写 mihomo 配置并重启内核,没变就只让内核重新拉一遍 provider。保存后的提示会告诉你刷到了几个节点。

数据(订阅、Key、用量、内核缓存)都在命名卷 `ciallo-data` 里。用命名卷不用 `./data` 绑挂,是因为容器里以 uid 1000 运行,宿主目录属主对不上会 permission denied;真要绑挂先 `mkdir data && sudo chown 1000:1000 data`。

---

## 开发

零 npm 依赖,Node ≥ 20。代码全在 `beta` 分支:

```bash
git clone -b beta https://github.com/MurasameCyan/Ciallo-DS4F-Proxy.git
cd Ciallo-DS4F-Proxy

npm test              # check(前端纯函数)+ anthropic(转换层)+ server(路由鉴权)+ e2e(整条链路)
npm run preview       # 不起内核,只看 UI
npm start             # 完整跑,需要 /data 可写

npm run verify:tunnel     # TLS-over-CONNECT 出站(要 openssl)
npm run verify:api        # 打真实部署,BASE=http://... KEY=... 两个环境变量驱动
```

`server/anthropic.mjs` 是纯函数 + 一个可注入回调的 `AnthropicStream`,所以整个转换层不用起 HTTP 就能断言。

```
server/
  index.mjs      路由、静态文件、面板 API
  gateway.mjs    上游转发、节点轮换、方言分发(OPENAI / ANTHROPIC)
  anthropic.mjs  Messages ⇄ Chat Completions 转换 + SSE 状态机
  mihomo.mjs     内核进程和控制端口
  config.mjs     配置读写、mihomo yaml 生成
```

加协议就多写一个 dialect 对象(`toUpstream` / `validate` / `respond` / `sink` / `fail`),轮换和冷却那套逻辑不用动。

---

## 镜像

`ghcr.io/murasamecyan/ciallo-ds4f-proxy:latest`,多架构。

**`docker compose pull` 报 `unauthorized`?** 不是构建失败。GHCR 新建的包默认私有,而且**不跟随仓库可见性** —— 仓库公开了包照样是私有的。仓库 owner 打开
`https://github.com/users/MurasameCyan/packages/container/ciallo-ds4f-proxy/settings`
→ Danger Zone → Change visibility → Public,点一次,之后每次推送都继承。这个没有 API,只能手点。

---

## 说明

免费额度是 opencode 给的,别拿它跑压测。机场订阅里有你的 token,面板明文显示 —— 所以 `PANEL_PASS` 是必填项,不是建议项。
