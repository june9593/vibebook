# vibebook Roadmap — 多 Sprint 拆解

**Date:** 2026-04-22（Sprint 2 收尾后重排，已对齐实际代码）
**Status:** Active
**Owner:** Yue

> **2026-04-22 重要修订**
> - 项目已改名 `memvc` → `vibebook`（npm 名冲突）。CLI / env / `~/.vibebook/`
>   迁移完成；in-repo 数据目录 `.memvc/` 保留以兼容旧仓库。
> - 原 Sprint 3「双 orphan 分支（`<device>` + `<device>-raw`）」**已废弃**：
>   单 `<device>` 分支同时承载 `raw_sessions/` + `book/` 已够。
> - Sprint 2 期间 user 已二次重跑 `digest --reset`，加上 input 过滤 + 中文
>   prompt + insightScore 后**内容质量已可接受**。
> - 因此新 Sprint 3 = **收尾打磨**（评估脚手架 + 小补丁 + `anthropic-api`
>   runner 实做），不再是大动作。

---

## 当前 Baseline（已完成）

### 抓取 + 同步（v0.1）
- `vibebook init / sync` 抓 Claude Code + VSCode Copilot Chat 的 raw + md
- AES-256-GCM 加密开关（raw 走加密；book 永远 plaintext）
- 配置 / 索引 / git push
- **Per-device branches**：`os.hostname()` → 分支；orphan；legacy main 迁移

### 分层知识库（v0.2 = Sprint 2，已完成）
- LlmRunner 抽象 + claude-cli runner（2.1）
- BookIndex（`.memvc/index.book.json`）读写（2.2）
- Batcher（greedy pack ≤100k tokens；同 project + 时间相邻优先）（2.3）
- Threading：runner per batch + 跨 batch slug merge + project-scoped 合并 +
  ≤5 sessions/thread 强切 + auto-recovery 漏 sessionId（2.4）
- Article 生成（中文三段式 prompt：主要产出 / 知识积累 / 踩过的坑 + 附录；
  SKIP 哨兵；失败隔离）（2.5）
- Chapter 全量重写（latestArticleHash + CHAPTER_VERSION 触发；失败保留旧版）（2.6）
- TOC 机械生成（front page + 全局 timeline + 每章 timeline）（2.7）
- sync 接入 digest pipeline（`runDigest` orchestrator；`--no-digest` flag）（2.8）
- `vibebook digest --redo` 重跑 failed thread + 强制重写所有 chapter（2.9）

### Sprint 2 期间额外完成（roadmap 之外）
- **Init wizard**：7 步交互式 Q&A（含 Q0 sync-to-remote）+ hybrid CLI 模式
- **`vibebook digest --reset`**：destructive 清空 `book/` + `index.book.json`
- **`vibebook workflow init`**：写 `.github/workflows/vibebook-aggregate.yml` +
  `scripts/merge-books.mjs`，auto commit + push
- **passphrase store**：`~/.vibebook/passphrase`（mode 0600）
- **本地模式**：wizard Q0 = no → 跳过 repo URL / encrypt / runner check
- **runner-check**：binary detection + install hint
- **包发布**：npm `vibebook`（MIT，bin: `vibebook`）

### Sprint 3 期间的大 pivot（2026-04-23）
- **放弃 GitHub Models in-CI digest 路线**。根因：GitHub Models 免费层对
  每个请求硬限 8K input / 4K output tokens（low/high/custom tier 无差别），
  + low-tier 15 req/min / 150 req/day / concurrency=1。Article 阶段输入动辄
  50K+ tokens，被截断 87%；+ 429 频发。这条路**不是代码能修的 bug**。
- **CI 新定位**：跨设备**机械合并**（不调 LLM）。每台机器本地 `vibebook sync`
  用 claude-cli 跑 digest（200K context），CI 只负责把各 device 分支的 `book/`
  合到 main —— 按 threadId 去重（latest-updatedAt 胜），chapter 各设备一份
  （`chapter.<device>.md`），重生 `book/index.md` + `book/_meta/timeline.md`。
- **删除**：`src/digest/runners/github-models.ts`、`src/github-models-catalog.ts`、
  `src/digest/model-limits.ts`、`config.runner` enum 里的 `"github-models"` +
  `"github-action"`、`init-wizard` 的 Q6 runner picker、`--all-models` flag、
  旧 workflow yaml（`vibebook-digest.yml`）
- **新增**：`assets/workflows/vibebook-aggregate.yml` + `assets/scripts/merge-books.mjs`
  + wizard 新 Q7 `enableAggregateCI` + `Config.enableAggregateCI`

### 内容质量护栏（Sprint 2 期间补的）
- **`project-filter.isRealProjectPath`**：过滤 `.worktrees-`、`-workspacestorage`、
  `.code-workspace`、20+ 位 hex、10+ 位数字前缀；用在 extract + 一次性
  BookIndex prune migration
- **claude-code adapter**：跳 `-vibebook-claude-` + `-memvc-claude-`、任意层
  `subagents/`
- **`session-signal`**：5 类关键词桶（debug/architecture/discovery/reasoning/
  evaluation；中英）→ 每 session insightScore + title + preview，喂给 threading
- **`with-isolated-cwd`** + **`sweepScratchDirs`**：每次 spawn `claude -p` 用
  mkdtemp cwd；每次 sync/digest 启动前 sweep 残留 scratch dir（防 crash 后污染）
- **Auto-recovery**：LLM 漏的 sessionId 自动补 1-session thread
- **`ARTICLE_VERSION` / `CHAPTER_VERSION`**：bump 即批量 regen，无需 reset
- **Stale-article regeneration**：orchestrator 启动时扫 articleVersion 不一致

### 仍未做的事 / 已知小痛点
- **anthropic-api runner** 仍 throw "not implemented"（Sprint 5 任务）
- **没有质量评估脚手架**（fixture + 评分脚本）
- **chapter prompt 偏短**（9 行）—— 待评估脚手架确认是否要扩

---

## 总体路线（鸟瞰，2026-04-23 pivot 后重排）

```
Sprint 3  收尾打磨 + anthropic-api + 评估脚手架 + CI 改机械聚合  ← 当前
Sprint 4  静态站点 / llmwiki（GitHub Pages，渲染 main 的 book/）
Sprint 5  anthropic-api runner 实做 + 多 runner 对比
Sprint 6  打磨：增量 chapter / judge-merge / tag /
          pull-books / 加密路径决策 / 多步 article
```

每个 sprint 后都应能 demo / 自用，**不积累半成品**。

---

## Sprint 3 — 收尾打磨 + CI 改机械聚合 + 评估脚手架（当前）

**目标：** 把 Sprint 2 落下的小尾巴扫干净；**pivot CI 从 in-CI LLM → 机械
跨设备聚合**；搭起能在 fixture 上跑"质量分"的脚手架。

**验收：**
1. `npm test` 全绿
2. CI 跑 `scripts/merge-books.mjs`（不调 LLM），跨设备 book 合并到 main
3. `scripts/eval-digest.mjs` 在 fixture 上输出可读的 markdown 报告
4. `anthropic-api` runner 挪到 Sprint 5（stub 仍保留）
5. wording 修正完毕 / `memvc` 字面残留清零（`.memvc/` backcompat 路径除外）

任务清单：

- ✅ **3.1 仓库卫生**：`.gitignore` + `memvc` 字符串审计 + wording
- ✅ **3.2 CI pivot 到机械聚合**：删 github-models runner + catalog +
  model-limits；新 `vibebook-aggregate.yml` + `merge-books.mjs`；
  wizard 加 `enableAggregateCI` Q7；workflow init 写两文件 + auto push
- [ ] **3.3 评估脚手架**：fixture + `scripts/eval-digest.mjs` + 一条 vitest
- [ ] **3.4 真实数据回归 + Baseline 文档**：`digest --reset` 跑一遍记录
- [ ] **3.5（可选）chapter prompt 扩写**：仅在 3.3 评估显示 chapter 偏弱时做

> Sprint 3 不引入新架构（不加 judge-merge、不加多步 pipeline、不动分支模型）。

相关 plan 文档：
- `docs/superpowers/plans/2026-04-22-sprint3-polish.md`（原计划）
- `docs/superpowers/plans/2026-04-23-pivot-ci-aggregate-only.md`（pivot 详细步骤）

---

## Sprint 4 — 静态站点 / llmwiki

**目标：** 把单设备 `<device>` 分支的 `book/` 渲染成可 GitHub Pages 部署
的静态站点，让"翻书"在浏览器里成立。

### 决策点（**Sprint 4 启动前先 brainstorm**）

候选方案（择一，不要并行）：

1. **MkDocs Material**：YAML 配 + `book/` 即写即出；最低成本，导航好看
2. **Karpathy 风 llmwiki**：自写极简 HTML 模板，单页 + JS 检索；最有个人风格
3. **Astro + 内置 markdown**：可扩展、性能好、上手中等
4. **VitePress**：Vue 生态，文档站标准

倾向：**默认 MkDocs Material**（成本低、能用），把 llmwiki 作为可选皮肤。

### Sprint 4 任务（以 MkDocs 为例，定后再细拆）

- **4.1 mkdocs.yml + 主题选择**
- **4.2 nav 自动生成脚本**：从 `book/index.md` 树结构 → mkdocs nav
- **4.3 GitHub Actions 部署**：`peaceiris/actions-gh-pages`
- **4.4 检索 / 标签**：mkdocs 内置 search；可选 tag plugin
- **4.5 手测 + 回到 README 写访问入口**

---

## Sprint 5 — anthropic-api runner

**目标：** 把唯一剩下的 stub runner 填实作。Claude CLI 是默认路径，但有些用户没
Claude Max 订阅或想自己出 API key，`anthropic-api` 让他们能走直连。

### Sprint 5 任务

- **5.1 `@anthropic-ai/sdk` 接入**：Sonnet / Opus 标准 200K context；Opus
  `[1m]` 扩展 1M context
- **5.2 `/v1/messages/count_tokens` 集成**（事前精确算 input tokens，避免猜）
- **5.3 streaming** 支持（article 阶段长输出时降延迟）
- **5.4 手测 + baseline 对比** claude-cli vs anthropic-api（质量、延迟、成本）
- **5.5 README / wizard 说明 `ANTHROPIC_API_KEY` env 用法**

---

## Sprint 6 — 打磨

按痛点抓，不一定按顺序：

- **6.1 增量 chapter 重写**：只对受影响 articles 部分增改，省 token
- **6.2 judge-merge**：threading 之上再派一个 LLM 决定哪些 thread 该合
- **6.3 tag 维度**：`book/tags/<tag>.md` 跨章索引
- **6.4 `vibebook pull-books <device>`**：拉别的设备的书分支到本地 worktree 浏览
- **6.5 retention / 压缩**：raw 老数据归档
- **6.6 加密路径决策**：根据这一年的实际使用，决定保留 / 移除 / 改默认
- **6.7 多步 article pipeline（draft → self-review → rewrite）**：Sprint 3
  的评估若显示瓶颈，再做

---

## Session 切换约定

- **每个 session 开工第一件事：** 读本文件确认下一个未做任务，必要时读对应 spec/plan
- **每个 session 收尾：** 在「当前 Baseline」追加一行已完成项，并把已完成的 task
  在对应 sprint 章节打 ✓
- **如果一个 task 中途超时：** 在 plan 文件里把已做完的 step 打勾、未做完的留 `- [ ]`，
  下个 session 直接续
- **不允许跨 sprint 跳跃**：除非当前 sprint 完成才进下一个；防止半成品堆积

---

## 已废弃 / 不在本 roadmap 里的事

- ~~原 Sprint 3 双 orphan 分支~~（2026-04-22 废弃，单 `<device>` 已够）
- ~~github-models runner + github-action runner~~（2026-04-23 废弃，删除
  代码；CI 改机械聚合不调 LLM。根因：GitHub Models 免费层 8K input cap）
- ~~原 Sprint 5 多 runner~~（缩减为"anthropic-api 实做"一项）
- 重新设计分支模型（已固化为 per-device branches）
- 跨设备 raw 同步（user 明确说"不需要别的设备的聊天记录"）
- 加密 book 内容（设计上 book 永远 plaintext）
