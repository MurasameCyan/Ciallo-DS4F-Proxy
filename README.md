# Ciallo DS4F Proxy

把 [opencode zen](https://opencode.ai) 的免费模型包成一个本地网关,同时支持 **OpenAI** 和 **Anthropic** 两种协议。

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

打开 <http://127.0.0.1:9527>,用 `.env` 里的凭据登录(HTTP Basic),在「配置」里填机场订阅地址、保存。节点会当场刷新,不用重启容器。

面板上那个 Key 就是接口 Key,复制走给 agent 用。

**升级:** `docker compose pull && docker compose up -d`

### .env

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PANEL_PASS` | ✅ | 面板密码。面板会**明文显示** API Key 和订阅地址(里面有机场 token),别用弱密码 |
| `PANEL_USER` | | 默认 `admin` |
| `SUBSCRIPTION_URL` | | 机场订阅(Clash/mihomo 格式)。只在首次启动播种,之后以面板里改的为准 |
| `API_KEY` | | 留空则首次启动自动生成,面板里可查可换 |
| `NODE_TEST_URL` | | 延迟探针地址,默认 `https://opencode.ai/`(HEAD 站点根路径,不碰 `/zen/v1`,不花额度)。这条请求是走节点发出去的,你本机连不上不影响 |
| `NODE_TEST_TIMEOUT_MS` | | 单次探测超时,默认 `5000`,取值夹在 1000–8000 之间。超时算不可用 |
| `SHOW_THINKING` | | 设成 `0` 关掉推理内容转发(见下文「推理内容」) |
| `GITHUB_REPO` | | 「检查更新」跟哪个仓库比,默认 `MurasameCyan/Ciallo-DS4F-Proxy`。改成自己的 fork 就查自己的 |
| `GITHUB_TRACK_REF` | | 跟哪个分支比,默认 `beta`(`latest` 镜像就是从它出的) |

compose 默认只绑 `127.0.0.1:9527`。想让同网段其它机器连,把端口改成 `"9527:9527"` —— 那等于把面板一起暴露到局域网,`PANEL_PASS` 必须是强密码。

---

## 接上你的工具

Base URL 就是面板首页显示的那个(它取的是你当前的访问地址 + `/v1`,反代/端口映射后面也对)。

**模型名随便填。** 上游那个免费端点只认 `deepseek-v4-flash-free`,所以网关转发前会把 `model` 一律改写成它。`/v1/models` 照样把免费模型都列出来(客户端要拿它填下拉框),但填哪个都是同一个模型在答,统计里也只会出现这一个。

这份清单是**现拉的**:网关经节点去 `GET https://opencode.ai/zen/v1/models`,从 60 多个模型里挑出免费的(`-free` 后缀,外加 `big-pickle` 这个没后缀的例外),缓存 30 分钟。不写死是因为写死过一次就漏了 —— 上游后来上线 `longcat-2.0-free`,而代码里那份列表没人记得改。拉不到就继续用上一份(冷启动时是代码里的兜底常量),清单不会变空。

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

**延迟排序 + 剔除死节点。** 订阅解析完自动测一遍延迟,快的排前面,轮换就按这个顺序取。测不通的直接不进候选表 —— 不然一个已经下线的节点每次轮换都要先浪费一次超时。测延迟这件事整包交给内核:一次 `GET /group/zen-pool/delay`,内核内部并发测完再一起回,我们不逐个节点发请求(节点名里常带 `/`,例如 `FI_1|1.4MB/s`,拼进 URL 路径要靠转义活着回来)。探针默认打上游 `https://opencode.ai/` 而不是 `gstatic.com/generate_204`:实测后者会让一份 17 节点的订阅**全部**测不通,而同一批节点跑上游是好的 —— 机场封 80 端口、劫持 Google 域名都很常见,探针自己到不了就会把能用的节点全判死。两条保险:全部节点都测不通时**不剔除任何一个**(那更像是探针地址本身不可达,不能让网关自己瘫掉),没测过的节点也不算死。面板上每个节点显示实测延迟,「测延迟」按钮可以随时重测;全灭时日志会把内核给的原因(比如 `all proxies timeout`)一起打出来,换探针地址就用 `NODE_TEST_URL`。

**推理内容。** `deepseek-v4-flash-free` 这类模型会先吐几分钟 `reasoning_content` 再出正文(实测「写个 SVG 动画」的提问 200 秒内推理 68000 字、正文 0 字)。这个字段在 OpenAI 协议里原样透传;在 Anthropic 协议里翻译成 `thinking` 块 —— 丢掉它的话客户端在 `message_start` 之后几分钟收不到任何事件,看起来就是卡死,而上游其实一直在吐。`SHOW_THINKING=0` 可以关掉,那时推理内容整段丢弃,也不占块序号。

**超时预算。** 一个请求从进来到回复上限 75 秒,剩不到 8 秒就不再开新尝试,直接回 504。不这么管的话,轮换会把单个请求拖到客户端自己超时,报出来的错和真实原因完全对不上。**流式没有总时长上限** —— 只要上游还在吐(哪怕吐的全是推理),就一直转发;彻底没动静 120 秒才判定断流。

**流开始后不重试。** 头一旦发出去,响应就定型了;这时候再换节点重发等于把两半响应拼给客户端。所以 `writeHead` 之后的任何失败都只做收尾 —— Anthropic 那边会补一个合法的 `error` + `message_stop`,客户端不会挂到超时。

**工具调用参数增量。** 流式的 tool 参数用 `input_json_delta` 一段段发。参考实现里是在第一个分片就 start+stop,长参数会被截断。

---

## 面板

单页,不分标签,从上到下:

| 区块 | 内容 |
| --- | --- |
| 页头 | 只有身份和版本:构建 hash + 「检查更新」+ 仓库入口 |
| 统计 | 请求总数(成功·失败)、成功率、Token 消耗(输入·输出·推理)、运行时长(最后请求·主用模型) |
| 接入 | Base URL、API Key(掩码显示,「重置」/「复制」)、可用模型 |
| 配置 | 网关 / 内核 / 节点三个状态灯,订阅地址 + 「保存并应用」,以及「重启内核」「清零统计」「手动重置」 |
| 运行日志 | 内核和网关的实时日志 |
| 节点池 | 按实测延迟排序,从上往下就是网关接下来会用的顺序。每行带延迟数字,当前节点标出来,冷却中的显示剩余秒数,测不通的划掉垫在最底下 |

状态灯和那三个按钮都在「配置」卡里,和订阅地址挨着 —— 看一眼状态然后动手是一回事,分在页头和卡片两个地方要来回扫视。

监听端口面板上看不到也改不了:容器对外端口由 compose 的 `ports` 决定,进程改绑只会让映射指向一个没人听的地方。要换端口改 compose(`/api/config` 也会忽略提交上来的 `port`,直接 POST 绕不过去)。

API Key 屏幕上永远是掩码,只有「重置」和「复制」两个动作 —— 复制的是真值。没有「显示」:留一串完整 key 在屏幕上没什么用,而它就在「复制」旁边。「重置」会先问一次,正在用旧 Key 的客户端会立刻收到 401。

订阅地址改完点保存**当场生效**:地址变了就重写 mihomo 配置并重启内核(期间 `/v1/*` 短暂返回 503,客户端重试即可),没变就只让内核重新拉一遍 provider。刷完节点接着自动测一遍延迟,保存后的提示会告诉你刷到几个、其中几个可用。

「清零统计」把请求数、Token 用量、按模型的分项全部归零并落盘,不可恢复,所以会先问一次。它不动订阅和 Key。

**构建 hash 和检查更新。** 页头右端那个等宽小牌子是当前镜像的构建 commit(点它跳到那次提交),旁边 ⟳ 拿它和 GitHub 上 `beta` 的 HEAD 比一下。**只在你点的时候才出站** —— 匿名 GitHub API 每小时 60 次,自动轮询会烧光,而且它一小时也变不了几次。有新版本时牌子变琥珀色,`docker compose pull && docker compose up -d` 之后牌子自己恢复(比的是两个 hash,不是那次检查的结果)。

牌子显示 `unknown` 说明这个镜像构建时没注入 `GIT_COMMIT` —— 自己 `docker build` 不带 `--build-arg GIT_COMMIT=$(git rev-parse HEAD)` 就会这样。此时不会报「有新版本」:本地 hash 不知道,新旧无从判断,报了只是让人白拉一次镜像。

**日志。** 分四级(信息 / 成功 / 警告 / 错误),面板上按级别筛。方括号里是发出这行的子系统,常见的:`[gateway]` `[mihomo]` `[chat]` `[stream]` `[429]`(限流换节点)`[delay]`(测延迟)`[update]`(检查更新)`[config]` `[reset]`。面板里只留最近 500 条,在内存里 —— 容器重启就空了。同样的内容也全写了 stdout,要翻更早的用 `docker compose logs -f`。

### 数据

都在命名卷 `ciallo-data`(容器内 `/data`):

| 文件 | 内容 |
| --- | --- |
| `config.json` | 订阅地址、API Key、端口。**含机场 token**,别往外发 |
| `usage.json` | 累计统计。「清零统计」写的就是它 |
| `mihomo-zen.yaml` | 生成的内核配置,每次改订阅地址重写 |
| `mihomo-data/` | 内核自己的缓存(provider 快照、GeoIP) |
| `last-node.txt` | 上次用的节点,重启后接着用它,不用从头试 |

用命名卷不用 `./data` 绑挂,是因为容器里以 uid 1000 运行,宿主目录属主对不上会 permission denied;真要绑挂先 `mkdir data && sudo chown 1000:1000 data`。

### 面板 API

面板自己就用这些,想脚本化(比如把状态接到自己的监控上)直接打:

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/status` | GET | 网关/内核状态、内核版本、固定模型、免费模型清单、构建标识 |
| `/api/config` | GET · POST | POST 保存订阅地址,**当场应用**;地址变了会重启内核。`port` 只读,提交了也忽略 |
| `/api/nodes` | GET | 排过序的节点表、被剔除的、延迟、冷却、当前节点 |
| `/api/nodes/test` | POST | 立刻测一遍延迟,回 `{tested, alive, fastest}` |
| `/api/usage` | GET | 统计。`/api/usage/reset` (POST) 清零 |
| `/api/regen-key` | POST | 换 API Key,不重启就生效 |
| `/api/restart` | POST | 重启内核 |
| `/api/reset` | POST | 清冷却 + 忘掉上次节点 + 重写配置 + 重启内核 |
| `/api/check-update` | POST | 跟 GitHub 上的 `GITHUB_TRACK_REF` 比一次 |
| `/api/logs` | GET | SSE。首帧是历史快照(数组),之后每条一帧 |

**全都要 Basic 鉴权**,和面板同一套凭据 —— 有副作用的都是 POST,别指望 GET 能触发。探活用 `/health`,那个不要鉴权。

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
npm run verify:upstream   # 出站是否真经代理(比对出口 IP),PROXY_PORT=2080 驱动
npm run verify:api        # 打真实部署,BASE=http://... KEY=... 两个环境变量驱动
```

`server/anthropic.mjs` 是纯函数 + 一个可注入回调的 `AnthropicStream`,所以整个转换层不用起 HTTP 就能断言。前端同一个思路:`web/core.js` 只放算出来的东西(节点排序、Key 掩码、时长格式化、新旧判断),`web/app.js` 只负责把结果贴到 DOM 上 —— 所以 `test/check.mjs` 不用浏览器就能把那些规则钉住。

```
server/
  index.mjs      路由、静态文件、面板 API
  gateway.mjs    上游转发、节点轮换、方言分发(OPENAI / ANTHROPIC)
  anthropic.mjs  Messages ⇄ Chat Completions 转换 + SSE 状态机
  mihomo.mjs     内核进程和控制端口
  config.mjs     配置读写、mihomo yaml 生成
  build.mjs      构建 hash(环境变量 → git)、跟 GitHub 比新旧
```

加协议就多写一个 dialect 对象(`toUpstream` / `validate` / `respond` / `sink` / `fail`),轮换和冷却那套逻辑不用动。

---

## 镜像

`ghcr.io/murasamecyan/ciallo-ds4f-proxy:latest`,多架构(`linux/amd64` + `linux/arm64`)。

| 标签 | 来源 |
| --- | --- |
| `latest` | `beta` 的每次推送 |
| `beta` | 同上,同一份 digest |
| `sha-<短 sha>` | 每次构建都留一个,用来回滚 |
| `1.2` / `1.2.3` | 打 `v*` 标签时出 |

**自己构建**记得带 `--build-arg GIT_COMMIT=$(git rev-parse HEAD)`,不然面板上的构建 hash 是 `unknown`(CI 里传的是 `github.sha`)。

**`docker compose pull` 报 `unauthorized`?** 不是构建失败。GHCR 新建的包默认私有,而且**不跟随仓库可见性** —— 仓库公开了包照样是私有的。仓库 owner 打开
`https://github.com/users/MurasameCyan/packages/container/ciallo-ds4f-proxy/settings`
→ Danger Zone → Change visibility → Public,点一次,之后每次推送都继承。这个没有 API,只能手点。

**想手动重建?** 往 `beta` 推一个空提交(`git commit --allow-empty -m rebuild && git push`)。Actions 页面上没有「Run workflow」按钮 —— `workflow_dispatch` 要求 workflow 文件在**默认分支**上,而默认分支是只有 README 的 `main`。`push` 触发不受影响,它用的是被推分支上的那份文件。

---

## 说明

免费额度是 opencode 给的,别拿它跑压测。机场订阅里有你的 token,面板明文显示 —— 所以 `PANEL_PASS` 是必填项,不是建议项。
