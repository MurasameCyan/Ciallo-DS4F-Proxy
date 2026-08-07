# Token 缓存明细与节点统计折叠实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在顶部“Token 消耗”卡中直接显示缓存读写 Token，并让独立“节点统计”卡默认折叠。

**架构：** 沿用现有原生 HTML/CSS/JavaScript，不引入新状态或依赖。Token 副文案直接消费 `usage.total` 已有的 `cacheReadTokens`、`cacheWriteTokens`；节点统计用语义化 `<details>` / `<summary>` 包裹现有摘要和明细，省略 `open` 属性以保证每次加载默认折叠。

**技术栈：** Node.js 20 ESM、原生 HTML/CSS/JavaScript、`assert/strict` 自检脚本。

---

## 文件结构

- 修改：`web/app.js` —— 在 Token 消耗副文案中格式化缓存读写值。
- 修改：`web/index.html` —— 同步 Token 占位文案，并把节点统计卡改成默认关闭的 `<details>` / `<summary>`。
- 修改：`web/style.css` —— 让折叠摘要沿用现有卡头布局，并仅在展开时恢复正文间距。
- 修改：`test/check.mjs` —— 锁定缓存读写展示字段、原生折叠结构与默认关闭状态。

### 任务 1：Token 明细与节点统计折叠

**文件：**
- 修改：`web/app.js:76-96`
- 修改：`web/index.html:70-74,192-204`
- 修改：`web/style.css:209-227,339-376`
- 测试：`test/check.mjs`

- [ ] **步骤 1：编写失败的回归测试**

在 `test/check.mjs` 读取 `web/app.js` 与 `web/index.html`，断言：

```js
assert.ok(app.includes('缓存读 ${fmtTokens(t.cacheReadTokens)}'));
assert.ok(app.includes('缓存写 ${fmtTokens(t.cacheWriteTokens)}'));
assert.match(html, /<details[^>]*class="card span3"[^>]*>/);
assert.match(html, /<summary[^>]*>[^]*节点统计[^]*<\/summary>/);
assert.doesNotMatch(html.match(/<details[^>]*class="card span3"[^>]*>/)?.[0] || '', /\sopen(?:\s|=|>)/);
```

同时断言静态 Token 占位文案包含 `缓存读 — · 缓存写 —`。

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/check.mjs`

预期：FAIL，指出缓存字段或 `<details>` / `<summary>` 结构尚不存在。

- [ ] **步骤 3：实现最小 UI 改动**

把 `renderStats()` 的副文案改为：

```js
`输入 ${fmtTokens(t.promptTokens)} · 输出 ${fmtTokens(t.completionTokens)}`
+ ` · 推理 ${fmtTokens(t.reasoningTokens)} · 缓存读 ${fmtTokens(t.cacheReadTokens)}`
+ ` · 缓存写 ${fmtTokens(t.cacheWriteTokens)}`
```

把节点统计的通栏 `<section>` 改为 `<details class="card span3">`，将标题与 `#nstat-sum` 放入 `<summary>`，列表和空态留在 details 正文中；不要添加 `open` 属性，不记忆展开状态。CSS 继续使用现有颜色、间距和响应式规则，不新增自定义 JavaScript 折叠状态。

- [ ] **步骤 4：运行定向与完整测试**

运行：

```bash
node test/check.mjs
npm test
```

预期：`check.mjs` 和完整测试全部通过。

- [ ] **步骤 5：真实页面布局检查**

启动现有 `npm run preview`，在桌面与窄屏下确认：节点统计首屏默认折叠；点击摘要可展开；摘要、明细和 Token 副文案无横向溢出。

- [ ] **步骤 6：提交**

```bash
git add web/app.js web/index.html web/style.css test/check.mjs docs/superpowers/plans/2026-08-07-token-cache-collapse.md
git commit -m "feat(面板): 显示缓存 Token 并折叠节点统计"
```

### 任务 2：发布 beta

**文件：** 无额外代码文件。

- [ ] **步骤 1：确认工作区与提交**

运行：

```bash
git status --short --branch
git log -1 --oneline
```

预期：位于 `beta`，工作区干净，最新提交是本计划的面板改动。

- [ ] **步骤 2：推送并确认构建**

运行：

```bash
git push origin beta
```

等待该提交触发的 GitHub Actions；必须确认测试 job 与多架构镜像构建/推送 job 均成功。若 GitHub 二级速率限制导致仅推镜像失败，等待限制解除后只重跑失败 job，不制造空提交。
