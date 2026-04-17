# memvc Layered Knowledge Base — Design

**Date:** 2026-04-17
**Status:** Approved (ready for writing-plans)
**Depends on:** `2026-04-17-per-device-branches.md` (already implemented)

## 目标

让用户能够**像翻书一样**回顾过去的工作：

- **项目 = 章**（chapter）
- **"一件事"（thread，可能跨多个 session）= 一篇文章**（article）
- **raw 对话 = 脚注**（留痕，不作为主要读物）

memvc 在 `memvc sync` 的时候自动从新 session 生成 thread/文章/章前言，并和机械生成的目录/时间线一起提交到**本设备的书分支**。`main` 由 GitHub Actions + GitHub Models 做跨设备聚合。

## 分支模型（双 orphan）

建立在已实现的 per-device-branches 之上：

| 分支 | 内容 | 访问频率 |
|---|---|---|
| `<device>-raw` | `raw_sessions/` + `.memvc/index.json`（原始流水）| 平时不 checkout；存档用 |
| `<device>` | `book/` + `.memvc/prompts/` + `.memvc/index.book.json`（书）| 主分支，用户平时翻 |
| `main` | 跨设备聚合后的 `book/`；GitHub Actions 生成 | 总视图；通过网页浏览 |

本地 via `git worktree` 维护两个工作目录，用户只看一个（书那个）。

## 目录布局

```
<device> 分支:
  book/
    index.md                                    ← 机械生成：书的首页 / 目录
    _meta/timeline.md                           ← 机械生成：全书时间线
    <project-slug>/
      chapter.md                                ← LLM 全量重写：项目前言
      timeline.md                               ← 机械生成：章内时间线
      articles/
        YYYY-MM-DD__<thread-slug>__<tid8>.md    ← LLM 生成：文章本体
  .memvc/
    index.book.json                             ← 书分支独立的书索引
    prompts/                                    ← `memvc init` 从 assets/prompts/ 拷入
      thread.md
      article.md
      chapter.md
  .github/workflows/memvc-merge.yml             ← 可选；memvc init 带一份

<device>-raw 分支:
  raw_sessions/<tool>/<project>/YYYY-MM-DD/<slug>__<shortId>.raw.json
  raw_sessions/<tool>/<project>/YYYY-MM-DD/<slug>__<shortId>.md
  .memvc/index.json                             ← 既有 session 索引
```

加密开关：raw/md 走原有行为；`book/**` 和 `*.summary.md` 永远 plaintext（为了能在 GitHub 网页上读）。

## 数据模型

### `.memvc/index.json`（在 raw 分支，沿用）

`IndexEntry` 字段不变。

### `.memvc/index.book.json`（在书分支，新增）

```ts
interface BookEntry {
  threadId: string;              // slug：稳定，跨 sync 追加新 session 不变
  project: string;
  title: string;                 // 中文人读短标题（≤ 20 字）
  sessionIds: string[];          // 属于这个 thread 的全部 session
  articlePath: string;           // "book/<proj>/articles/..." 相对仓库根
  articleVersion: number;        // 生成时的 prompt/模型版本
  latestSourceSha: string;       // concat(sessionIds 对应 sourceSha256) 的 hash；变了就要重写 article
  articleStatus: "ok" | "failed";
  articleError?: string;
  skip?: boolean;                // thread 判定为无效（纯 say-hi 等）
  skipReason?: string;
  updatedAt: string;             // ISO
}

interface BookIndex {
  version: 1;
  threads: Record<string /* threadId */, BookEntry>;
  chapters: Record<string /* project */, {
    chapterVersion: number;
    lastFullRewrite: string;     // ISO；每次重写都更新
    latestArticleHash: string;   // 受影响的 articles 内容哈希，用来判断要不要重写
  }>;
}
```

## Pipeline（`memvc sync` 扩展）

```
1. extract                                      （既有）
   adapter.discover() → writeSession() → raw worktree
   upsertEntry(.memvc/index.json)

2. push raw worktree
   ensureDeviceBranch(<device>-raw) → commitAndPush

3. digest.plan
   扫 .memvc/index.json 找「新 session」（未出现在任何 BookEntry.sessionIds 里）
   扫 BookIndex.threads 找「有新 session 要并入的 thread」（通过下面 threading 阶段的结果）
   扫 BookIndex.threads 找「articleVersion 升级」需要重写的 thread
   输出 { newSessions[], staleThreads[] }

4. digest.thread        （仅当 newSessions 非空）
   batcher.makeBatches(newSessions, maxTokens=100_000)
     （每个 batch 喂 thread prompt 一次 `claude -p` 调用）
   Promise.all 并发所有 batch
   threading.merge() 跨 batch 合并同 slug 的 threadId，更新 BookIndex.threads
   把 newSessions 分配进相应 thread

5. digest.article       （对每个 articleVersion 过期 / latestSourceSha 改变 / skip=false 的 thread）
   读取该 thread 所有 session 的 md，拼成输入
   `claude -p` 带 article prompt 生成文章
   写入 book/<proj>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md
   更新 BookEntry.articlePath / articleVersion / latestSourceSha

6. digest.chapter       （只对 articles 实际变过的 project）
   读该章下所有 articles
   `claude -p` 带 chapter prompt，全量重写 chapter.md
   更新 BookIndex.chapters[proj].lastFullRewrite

7. digest.toc           （机械，不走 LLM）
   book/index.md（书首页）
   book/_meta/timeline.md（跨章全局时间线）
   book/<proj>/timeline.md（每章时间线）

8. push book worktree
   ensureDeviceBranch(<device>) → commitAndPush
```

失败处理：

- 阶段 4（thread）任意 batch 失败 → 中止阶段 4-7，保留阶段 1-2 的 push，下次 sync 重试
- 阶段 5（article）单条失败 → 该 thread 置 `articleStatus: "failed"`，其它 thread 继续
- 阶段 6（chapter）单章失败 → 保留上一版 chapter.md，打印 warning
- 所有失败都可通过 `memvc digest --redo` 重跑

## 代码结构

### 新文件

```
src/
  digest/
    types.ts              BookEntry / ThreadCandidate / ArticleDraft 等类型
    runner.ts             runClaude(promptFile, vars, opts) — spawn `claude -p` 子进程
    batcher.ts            按 token 预算把 session 切 batch
    threading.ts          fan-out subagents + 全局 merge
    article.ts            一个 thread → 一篇 article
    chapter.ts            一个 project 全部 articles → chapter.md（全量重写）
    toc.ts                机械 toc / timeline 生成
    book-index.ts         读写 .memvc/index.book.json
  commands/
    sync.ts               extend to call pipeline 阶段 3-8
    digest.ts             `memvc digest --redo` 命令
  git-ops.ts              增 setupDualWorktrees()、改 ensureDeviceBranch 支持两个分支
assets/
  prompts/
    thread.md
    article.md
    chapter.md
tests/
  digest/
    batcher.test.ts
    threading.test.ts     （mock runner）
    article.test.ts       （mock runner）
    chapter.test.ts       （mock runner）
    toc.test.ts
    book-index.test.ts
```

### `runClaude` 签名

```ts
export type ClaudeRunResult =
  | { ok: true;  text: string; stderr: string; durationMs: number }
  | { ok: false; error: string; stderr: string; durationMs: number };

export async function runClaude(
  promptFile: string,                       // .memvc/prompts/thread.md 等
  variables: Record<string, string>,        // {{sessionMd}}、{{sessionList}} 等占位符
  opts?: { timeoutMs?: number; outputFormat?: "json" | "text" },
): Promise<ClaudeRunResult>;
```

执行 `claude -p --output-format json` 子进程，stdout 解析 JSON。默认超时 180s。

### `threading.merge` 算法（纯代码，确定性）

```
输入：K 份 batch 结果，每份是 ThreadCandidate[]
  ThreadCandidate = { threadId, sessionIds, title, skip?, reason? }

1. 所有 entries 按 threadId 分组；同 slug 合并 sessionIds（去重、按 endedAt 排序）
2. 相似 slug 检测：
   - normalize: 小写 + 去重连字符 + 去末尾数字
   - 若两个 normalize 相等，或一个是另一个前缀，择 canonical：优先更长的、其次更早出现的
   - 再合一次
3. 输出 BookEntry[]
```

### Batcher

输入 `NormalizedSession[]`，按以下流程：

1. 计算每个 session 的 approx token（md 字符数 / 3.5）
2. 贪心装箱：新 session 加进当前 batch，若超 `maxTokens` 则开新 batch
3. 保证同 project + 时间相邻的 session 优先进同一 batch（质量），否则会导致 threading 见不到全貌

### Prompt 初版（中文，拷到用户仓库 `.memvc/prompts/`）

`thread.md`：

```
你是一个代码工程师的助手。要把一批零散的编码 session 分组成"一件事"（thread）。

规则：
1. 同一个项目 + 话题相关 + 时间相邻（一般 < 7 天）的 session 合并成一个 thread
2. 无意义 session（纯 say-hi、没实质内容、几轮简短问答）标 skip: true
3. threadId 是 slug：小写字母数字短横线；描述"这件事"，如 "fix-copilot-scan"
4. title 是中文短标题，≤ 20 字

输入：SESSION_LIST (JSON)
输出：纯 JSON，不要 markdown 代码块

SCHEMA: [{ "sessionIds": ["..."], "threadId": "...", "title": "...", "skip": false, "reason"?: "..." }]

SESSION_LIST:
{{sessionList}}
```

`article.md`：

```
你要把下面若干个 session 合成一篇工程博客风格的文章。

要求：
- 用中文
- 结构：标题（# ）；导语 1-2 段讲背景；正文分小节讲"发现的问题 → 尝试的方案 → 最终做法 → 学到的东西"；结尾 "## 附：原始对话" 列出 raw_sessions 相对路径链接
- 避免逐字引用对话；提炼叙事
- 代码片段保留，命令行保留
- 如果内容太杂乱以至于写不成一篇文章，返回单行 "SKIP: <原因>"

THREAD_TITLE: {{title}}
SESSIONS (由旧到新):
{{sessionsMd}}
```

`chapter.md`：

```
你要为一个项目写"章前言"，介绍这个项目以及我在上面做过的主要事情。

要求：
- 用中文
- 结构：# <项目名>；一段项目是什么；"## 主要工作" 小节分点列出每一篇文章讲了啥；"## 发现 / 坑" 小节汇总踩过的坑与结论
- 简洁，≤ 800 字

ARTICLES (新到旧):
{{articles}}
```

### 新 CLI

```
memvc sync                 # extract + thread + article + chapter + toc + push 两个分支
memvc sync --no-digest     # 只跑 extract（v0.1 行为）
memvc digest --redo        # 重跑所有 articleStatus="failed" 的 thread 和上一版 chapter
```

## GitHub Actions（main 聚合）

`.github/workflows/memvc-merge.yml`（`memvc init` 复制到用户仓库）：

```
trigger: push 到任何 refs/heads/* 除 main 以外
steps:
  1. checkout main（如果不存在则 git checkout --orphan main）
  2. 对每个非 main 分支：git show <branch>:book/ → 合并到 main 的 book/ 下
     - articles 去重（按 threadId）；同 threadId 多设备优先时间更晚的
     - chapter.md：**不重写**，选各设备里最新那份，并列展示（"本章由 <device> 撰写"）
  3. 重新机械生成 book/index.md 和 timeline.md
  4. commit & push main
```

权限：workflow 用仓库默认 `GITHUB_TOKEN`，不需要用户配额外 secret。gh models 不在第一版里；第一版 main 聚合只做**机械合并**，保证读物质量来自设备分支。

## 加密

- `raw_sessions/` 和 `.raw.json`/`.md`（位于 `<device>-raw` 分支）：沿用既有 `encrypt` 开关
- `book/**`、`*.summary.md`、`.memvc/index.book.json`：永远 plaintext，不受 encrypt 影响

## Out of Scope（留给下一个 sprint）

- `memvc pull-books <device>`：把他机的书分支拉本地浏览
- 基于 tag 的第二维度（`book/tags/<tag>.md`）
- 静态站点（llmwiki / GitHub Pages）生成 — Sprint 2 item 3
- pre-merge judge-merge（再派一个 LLM 决定哪些 thread 该合）
- 增量 chapter（现在总是全量重写）

## 关键决策摘要

| 决策 | 选择 | 理由 |
|---|---|---|
| 文章单位 | thread（一件事），不是 session | 多 session 才是一件事；垃圾 session 应 skip |
| 章前言 | 每次全量重写 | 防漂移；项目文章数有限，成本可控 |
| LLM runner | `claude -p` 子进程 | 用户已有；无 API key；质量高 |
| Fan-out | batch=100k，并发 `claude -p`，主进程纯代码 merge | 质量第一，token 不设上限 |
| 分支模型 | `<device>` + `<device>-raw` 双 orphan | 书轻量、原文存档、别的设备只拉书 |
| main 聚合 | GitHub Actions 机械合并（非 LLM 重写） | 质量留在设备分支；CI 零额外配置 |
| Trigger | 默认 sync 就跑 digest | 一条命令贯通 |
| 失败处理 | 细粒度 skip + `memvc digest --redo` | 单点失败不阻塞整体 |
