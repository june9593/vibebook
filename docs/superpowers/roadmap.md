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
- **`vibebook workflow init`**：写 `.github/workflows/vibebook-digest.yml`
- **github-models runner** 已实做：`models.github.ai/inference` OpenAI 兼容
  协议；`GITHUB_TOKEN` / `VIBEBOOK_GITHUB_TOKEN`；默认 `openai/gpt-4o-mini`
- **github-action runner**：`runner.ts` 在 `VIBEBOOK_CI=1` 时 dispatch 到
  github-models；workflow 自动从 secret + repo-salt 重组 config
- **passphrase store**：`~/.vibebook/passphrase`（mode 0600）
- **本地模式**：wizard Q0 = no → 跳过 repo URL / encrypt / runner check
- **runner-check**：binary detection + install hint
- **包发布**：npm `vibebook`（MIT，bin: `vibebook`）

### 内容质量护栏（Sprint 2 期间补的）
- **`project-filter.isRealProjectPath`**：过滤 `.worktrees-`、`-workspacestorage`、
  `.code-workspace`、20+ 位 hex、10+ 位数字前缀；用在 extract + 一次性
  BookIndex prune migration
- **claude-code adapter**：跳 `-vibebook-claude-`、任意层 `subagents/`
- **`session-signal`**：5 类关键词桶（debug/architecture/discovery/reasoning/
  evaluation；中英）→ 每 session insightScore + title + preview，喂给 threading
- **`with-isolated-cwd`**：每次 spawn `claude -p` 用 mkdtemp cwd，跑完连
  `~/.claude/projects/<dash-encoded>/` 一起删
- **Auto-recovery**：LLM 漏的 sessionId 自动补 1-session thread
- **`ARTICLE_VERSION` / `CHAPTER_VERSION`**：bump 即批量 regen，无需 reset
- **Stale-article regeneration**：orchestrator 启动时扫 articleVersion 不一致

### 仍未做的事 / 已知小痛点
- **anthropic-api runner** 仍 throw "not implemented"（Sprint 5 → 提前到 3）
- **没有质量评估脚手架**（fixture + 评分脚本）
- **`docs/superpowers/plans/*` 没入 .gitignore**，容易污染仓库
- **`memvc` 残留字符串**：散落在文档 / 注释 / 偶发 wording
- **wording**：`runner 'github-action' only works ...` 读起来像报错
- **chapter prompt 偏短**（9 行）—— 待评估脚手架确认是否要扩

---

## 总体路线（鸟瞰，2026-04-22 重排）

```
Sprint 3  收尾打磨 + anthropic-api + 评估脚手架        ← 当前
Sprint 4  静态站点 / llmwiki（GitHub Pages）           ← 把"翻书"做出来
Sprint 5  main 聚合（GH Actions 跨设备合并 book/）      ← user work repo
                                                       在 Enterprise，
                                                       Actions 受限；
                                                       看落地难度
Sprint 6  打磨：增量 chapter / judge-merge / tag /
          pull-books / 加密路径决策 / 多步 article
```

每个 sprint 后都应能 demo / 自用，**不积累半成品**。

---

## Sprint 3 — 收尾打磨 + 评估脚手架 + anthropic-api（当前）

**目标：** 把 Sprint 2 落下的小尾巴扫干净，搭起一个能在 fixture 上跑出
"质量分"的脚手架，并把最后一个真 stub runner（anthropic-api）补完。

**验收：**
1. `npm test` 全绿，包含一条 `tests/digest/quality-eval.test.ts` 跑评估脚本
2. `scripts/eval-digest.mjs` 在 fixture 上输出可读的 markdown 报告
3. `anthropic-api` runner 在 mock fetch 下测试通过；在 user 自己机器上手测一次
4. `.gitignore` 覆盖 `docs/superpowers/plans/*`、`.claude/worktrees/`、其它
   AI 副产物
5. 全仓搜 `memvc`（除 backcompat 路径 `.memvc/`、git history 字面、URL）= 0
6. wording 修正完毕

详细 step-by-step 见 `docs/superpowers/plans/2026-04-22-sprint3-polish.md`。

任务清单（plan 已细化）：

- **3.1 仓库卫生**：`.gitignore` + `memvc` 字符串审计 + wording
- **3.2 anthropic-api runner**：`@anthropic-ai/sdk` 实做 + 测试
- **3.3 评估脚手架**：fixture + `scripts/eval-digest.mjs` + 一条 vitest
- **3.4 真实数据回归 + Baseline 文档**：`digest --reset` 跑一遍记录
- **3.5（可选）chapter prompt 扩写**：仅在 3.3 评估显示 chapter 偏弱时做

> Sprint 3 不引入新架构（不加 judge-merge、不加多步 pipeline、不动分支模型）。

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

## Sprint 5 — main 聚合（GitHub Actions）

**目标：** push 任意 `<device>` 分支后，Actions 自动把所有设备的 `book/`
合并到 `main`。

**前置警告：** user 主 work repo 在 GitHub Enterprise，Actions 可能受限；
若启用不了，本 Sprint 的产出 = "个人 GitHub 上能用 + Enterprise fallback 文档"。

### Sprint 5 任务

- **5.1 workflow yaml**（trigger：`push: branches-ignore: [main]`）
- **5.2 articles 去重逻辑**（按 `threadId` + `BookEntry.updatedAt` 留最新）
- **5.3 chapter 并列展示**（多设备同 project 各自的 `chapter.md` 都保留）
- **5.4 init 拷一份 workflow + `--no-workflow` flag**
- **5.5 手测多设备 + Enterprise fallback 文档**

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
- ~~原 Sprint 5 多 runner~~（github-models 已实做；anthropic-api 提前到 Sprint 3）
- 重新设计分支模型（已固化为 per-device branches）
- 跨设备 raw 同步（user 明确说"不需要别的设备的聊天记录"）
- 加密 book 内容（设计上 book 永远 plaintext）
