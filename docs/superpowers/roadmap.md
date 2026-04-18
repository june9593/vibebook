# memvc Roadmap — 多 Sprint 拆解

**Date:** 2026-04-18
**Status:** Active
**Owner:** Yue

本文档把「分层知识库 + 静态站点」的工作拆成多个 sprint，每个 sprint 控制在
一个 session 能产出的体量内，避免单次任务超时丢文档。

---

## 当前 Baseline（已完成）

- ✅ `memvc init / sync` 抓取 Claude Code + VSCode 的 raw + md
- ✅ 加密开关（raw 走加密；book 永远 plaintext，留给后续）
- ✅ 配置 / 索引 / git push
- ✅ **Per-device branches**（`os.hostname()` → 分支；orphan；legacy main 迁移）
  —— commit `b130177`, `00b8b42`
- ✅ Spec：`docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md`
- ✅ Spec：可配置 LLM Runner（`claude-cli` / `anthropic-api` / `github-models`）
- ✅ **Sprint 2.1 + 2.2**：LlmRunner 抽象 + BookIndex 读写
- ✅ **Sprint 2.3 + 2.4**：Batcher（greedy pack） + Threading（runner per batch + cross-batch slug merge）
- ✅ **Sprint 2.5**：Article 生成（单 thread，text-mode runner，SKIP 哨兵，失败隔离）
- ✅ **Sprint 2.6**：Chapter 全量重写（latestArticleHash 触发，CHAPTER_VERSION 触发，失败保留旧版）
- ✅ **Sprint 2.7**：TOC 机械生成（front page + 全局 timeline + 每章 timeline，markdown 转义）
- ✅ **Sprint 2.8**：sync 接入 digest pipeline（runDigest orchestrator；--no-digest flag；book 分支二次 commit）
- ✅ **Sprint 2.9**：`memvc digest --redo` 命令（重跑 failed thread；强制重写所有 chapter）

## 总体路线（鸟瞰）

```
Sprint 2  分层知识库 MVP（claude-cli runner，单设备闭环）
Sprint 3  双 worktree + 双分支（<device> 书分支 + <device>-raw 原始分支）
Sprint 4  GitHub Actions main 聚合 + 多设备书阅读
Sprint 5  Runner 多后端（anthropic-api, github-models / Copilot）
Sprint 6  静态站点输出（llmwiki / GitHub Pages / MkDocs 等，二选一）
Sprint 7  打磨：增量 chapter、judge-merge、tag 维度
```

每个 sprint 后都应能 demo / 自用，**不积累半成品**。

---

## Sprint 2 — 分层知识库 MVP（单分支验证管线）

**目标：** 不动分支模型，先在当前 `<device>` 分支上端到端跑通
`session → thread → article → chapter → toc`，产出 `book/` 目录，自己能翻。

**验收：** 跑 `memvc sync` 后，`book/<project>/articles/*.md` 和
`book/<project>/chapter.md` 在仓库里能直接在 GitHub 网页上读。

### Sprint 2 任务

- **2.1 LlmRunner 接口 + claude-cli 实现**
  - `src/digest/runner.ts`：`LlmRunner` 接口、`createRunner(config)` 工厂
  - `src/digest/runners/claude-cli.ts`：`spawn('claude', ['-p', '--output-format', 'json'])`，stdout 解析
  - `src/digest/runners/anthropic-api.ts`、`github-models.ts`：throw "not implemented"
  - Config 增 `runner: "claude-cli"`、`runnerModel: ""`
  - 测试：mock spawn，跑通超时、错误、模型透传
- **2.2 BookIndex 读写**
  - `src/digest/book-index.ts`：`BookIndex` / `BookEntry` 类型 + `read/write/upsert`
  - 文件 `.memvc/index.book.json`，缺失时创建空骨架
  - 测试：upsert、覆盖、`latestSourceSha` 比对
- **2.3 Batcher**
  - `src/digest/batcher.ts`：贪心装箱，约 100k tokens/batch（字符 / 3.5 估）
  - 同 project + 时间相邻优先合 batch
  - 测试：边界（单 session > maxTokens、同项目按时间排）
- **2.4 Threading**
  - `src/digest/threading.ts`：调 runner 拿 `ThreadCandidate[]`，纯代码 merge
  - prompt：`assets/prompts/thread.md`
  - merge 算法：slug 归一、前缀合并、`skip` 透传
  - 测试：mock runner，跨 batch 合并相同 slug
- **2.5 Article 生成**
  - `src/digest/article.ts`：每个非 skip thread 拼 sessionsMd → runner → 写 `book/<proj>/articles/...`
  - prompt：`assets/prompts/article.md`
  - 失败：写 `articleStatus="failed" + articleError`，不阻塞其它
  - 测试：mock runner，写出文件、index 更新
- **2.6 Chapter 全量重写** ✓
  - `src/digest/chapter.ts`：每个 articles 实际变过的 project 全量重写 `chapter.md`
  - prompt：`assets/prompts/chapter.md`
  - 测试：mock runner、`latestArticleHash` 触发条件
- **2.7 TOC（机械生成）** ✓
  - `src/digest/toc.ts`：`book/index.md`、`book/_meta/timeline.md`、每章 `timeline.md`
  - 纯字符串拼接，不调 LLM
  - 测试：fixture → snapshot
- **2.8 sync 接入 pipeline** ✓
  - `src/commands/sync.ts`：extract 之后跑阶段 3-7（plan/thread/article/chapter/toc），最后一次 push
  - 加 `--no-digest` flag 走旧路径
  - 整合测试：fixture 仓库 + mock runner，跑完 `memvc sync`，断言 `book/` 内容
- **2.9 `memvc digest --redo` 命令** ✓
  - `src/commands/digest.ts`：把所有 `articleStatus="failed"` 重跑；强制重写所有 chapter
  - 测试：fixture，先制造 failed，再 redo

> **执行方式：** 任务 2.1 → 2.8 大致线性，2.7 可与 2.4/2.5/2.6 并行。建议
> 一个 session 做 2.1 + 2.2，下一个 session 做 2.3 + 2.4，再下一个做
> 2.5 + 2.6 + 2.7，最后一个做 2.8 + 2.9。每 session 留 buffer 写 plan 文档。

### Sprint 2 产出文档

- `docs/superpowers/plans/2026-04-XX-layered-kb-mvp.md`（写完才开工，按 spec 拆 step-by-step）

---

## Sprint 3 — 双 worktree + 双 orphan 分支

**目标：** raw 和 book 分到两个 orphan 分支（`<device>-raw` / `<device>`），
本地用 `git worktree` 同时挂两个工作树。

**为什么放在 Sprint 2 之后：** 先验证分层管线本身，再处理双分支机械。
分支拆分是封装 / 部署问题；管线对错才是核心。

### Sprint 3 任务

- **3.1 git-ops 增 setupDualWorktrees()**
  - `<device>-raw` 收 `raw_sessions/` + `.memvc/index.json`
  - `<device>` 收 `book/` + `.memvc/index.book.json` + `.memvc/prompts/`
  - 默认本地仓库结构：`~/memvc-repo/`（书）+ `~/memvc-repo/.git-raw-worktree/`（raw）
- **3.2 sync 写两路、push 两次**
  - extract 写到 raw worktree、commit & push `<device>-raw`
  - digest 写到 book worktree、commit & push `<device>`
- **3.3 init 拷贝 prompts 到 `.memvc/prompts/`**
  - `assets/prompts/{thread,article,chapter}.md` → 用户仓库 book 分支
  - 用户可改 prompt 后续 sync 用本地的
- **3.4 迁移：单分支用户 → 双分支**
  - 检测仓库目录里同时有 `raw_sessions/` 和 `book/`，把 book 移到新 worktree、保留 raw 在原 worktree
  - 一次性脚本，写日志
- **3.5 文档 + 手测**
  - 更新 README 双分支章节
  - 手测：fresh init → 两次 sync → GitHub 网页能看到两个分支

---

## Sprint 4 — main 聚合（GitHub Actions）

**目标：** push 任意 `<device>` 分支后，Actions 自动把所有设备的 `book/` 合并到 `main`。

### Sprint 4 任务

- **4.1 workflow yaml**
  - `.github/workflows/memvc-merge.yml`，trigger：`push: branches-ignore: [main]`
  - checkout main（不存在则 orphan）
  - 遍历所有非 main 分支，`git show <branch>:book/` 提取
- **4.2 articles 去重逻辑**
  - 按 `threadId` 去重；多设备同 thread 留最新（按文件 mtime / `BookEntry.updatedAt`）
  - 节点脚本 `scripts/merge-books.mjs`，被 workflow 调
- **4.3 chapter 并列展示**
  - 不重写；多设备同 project 各自的 `chapter.md` 都保留，文件名带 device 后缀
  - 在 `book/index.md` 上加导航
- **4.4 init 拷一份 workflow**
  - `memvc init` 把 `assets/.github/workflows/memvc-merge.yml` 写入用户仓库
  - 给一个 flag `--no-workflow` 跳过
- **4.5 手测多设备**
  - 至少两台机器或两个 device 名 push，看 main 自动合并

---

## Sprint 5 — Runner 多后端

**目标：** 把 `anthropic-api` / `github-models` runner 实做掉。

> 用户原话：「调用 GitHub copilot 来做这个事情」→ 走 GitHub Models endpoint。

### Sprint 5 任务

- **5.1 anthropic-api runner**
  - `@anthropic-ai/sdk`，从 `ANTHROPIC_API_KEY` 读
  - 把 prompt + vars 拼成 `messages`，处理 streaming / 超时
  - 测试 + 手测一次
- **5.2 github-models runner**
  - GitHub Models REST endpoint（OpenAI 兼容协议），从 `GITHUB_TOKEN` 读
  - 默认 model：`gpt-4o`（或当前可选最强）
  - 测试 + 手测
- **5.3 runner 切换 e2e**
  - `memvc sync --runner github-models` 临时覆盖
  - 文档列三个 runner 的差异 / 限额 / 适用场景
- **5.4 cost / latency 对比**
  - 在三个 runner 上跑同样 thread，记一份对比 markdown 进 docs/

---

## Sprint 6 — 静态站点 / llmwiki

**目标：** 把 main 分支的 `book/` 渲染成可 GitHub Pages 部署的静态站点。

### 决策点（**Sprint 6 启动前先 brainstorm**）

候选方案（择一，不要并行）：

1. **MkDocs Material**：YAML 配 + `book/` 即写即出；最低成本，导航好看
2. **Karpathy 风 llmwiki**：自写极简 HTML 模板，单页 + JS 检索；最有个人风格
3. **Astro + 内置 markdown**：可扩展、性能好、上手中等
4. **VitePress**：Vue 生态，文档站标准

倾向：**默认 MkDocs Material**（成本低、能用），把 llmwiki 作为可选皮肤。

### Sprint 6 任务（以 MkDocs 为例，定后再细拆）

- **6.1 mkdocs.yml + 主题选择**
- **6.2 nav 自动生成脚本**：从 `book/index.md` 树结构 → mkdocs nav
- **6.3 GitHub Actions 部署**：`peaceiris/actions-gh-pages`
- **6.4 检索 / 标签**：mkdocs 内置 search；可选 tag plugin
- **6.5 手测 + 回到 README 写访问入口**

---

## Sprint 7 — 打磨

不一定按顺序，按痛点抓：

- **7.1 增量 chapter 重写**：只对受影响 articles 部分增改，省 token
- **7.2 judge-merge**：threading 之上再派一个 LLM 决定哪些 thread 该合
- **7.3 tag 维度**：`book/tags/<tag>.md` 跨章索引
- **7.4 `memvc pull-books <device>`**：拉别的设备的书分支到本地 worktree 浏览
- **7.5 retention / 压缩**：raw 分支老数据归档

---

## Session 切换约定

- **每个 session 开工第一件事：** 读本文件确认下一个未做任务，必要时读对应 spec/plan
- **每个 session 收尾：** 在「当前 Baseline」追加一行已完成项，并把已完成的 task 在
  对应 sprint 章节打 ✓
- **如果一个 task 中途超时：** 在 plan 文件里把已做完的 step 打勾、未做完的留 `- [ ]`，
  下个 session 直接续
- **不允许跨 sprint 跳跃**：除非当前 sprint 完成才进下一个；防止半成品堆积

---

## 不在本 roadmap 里的事

- 重新设计分支模型（已固化为 per-device branches，user 已确认）
- 跨设备 raw 同步（用户明确说「不需要别的设备的聊天记录」）
- 加密 book 内容（设计上 book 永远 plaintext，方便 GitHub 网页读）
