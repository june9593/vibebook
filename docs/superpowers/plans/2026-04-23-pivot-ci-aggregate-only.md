# Pivot: CI = aggregate-only (drop in-CI LLM)

**Date:** 2026-04-23
**Status:** Plan ready, code change is the next session's job
**Owner:** Yue
**Roadmap:** `docs/superpowers/roadmap.md` → effectively merges old Sprint 4 (main aggregation) into the current pivot, retires Sprint 5 (multi-runner) since `github-models` runner is being deleted.

---

## 背景

之前的设计：CI 走 GitHub Models（free tier）跑 digest pipeline。这条路有
**结构性问题**，不是写代码能修的：

- 每个请求 8K input / 4K output token 硬上限（free tier 全模型都这样）
- low-tier 15 req/min, 150 req/day；high-tier 50/day
- 必须 concurrency=1 否则 429 全挂；user 实际 work-memory 仓库 131 batches × ~5s = 11+ 分钟，撞 429 后 60s backoff，常 30+ 分钟
- Article 阶段输入动辄 50K tokens，被截到 ~6500 tokens → 文章质量"半身不遂"
- 我们已经为这条路改了 8+ 次（catalog filter / 截断 / 429 retry / 模型选择 / paid-tier 区分 ...）

**结论**: 8K cap 是 GitHub 业务模型决定的硬约束，vibebook 改不动。

## 新设计

**CI 不调 LLM**。CI 只做**机械跨设备聚合** —— 把所有 device 分支的 `book/`
合到 `main`，让多设备 user 在 GitHub 网页上有个统一总视图。

LLM 部分**全部回到本地** `claude-cli` runner（user 在自己电脑上跑 `vibebook sync`，
带 200K context，没有 8K 限额）。

| 维度 | 旧设计 | 新设计 |
|---|---|---|
| 谁跑 LLM | CI（GitHub Models） | 本地（claude-cli） |
| 谁跑机械合并 | 没有这一层 | CI（轻量 mjs 脚本） |
| Token cap | 8K input / 4K output | 200K input / 64K output（claude-cli） |
| Article 质量 | 截断/SKIP 多 | 完整 |
| CI 跑时长 | 11-30+ 分钟 | < 1 分钟（无 LLM） |
| 仓库代码 | github-models runner + catalog + paid-tier filter + truncation + retry + workflow yaml + salt + secret | 一个 yaml + 一个 mjs |

## 验收标准

1. `vibebook init` wizard 里 Q6 没有 "GitHub Action" 选项；只剩 `claude-cli`（实际就一个选项，跳过即可）
2. Wizard 加 `Q7: Enable CI book aggregation across devices? (y/n)` —— 选 y 后续走 `vibebook workflow init`
3. `vibebook workflow init` 写的是 `vibebook-aggregate.yml`，**不调 LLM，不需要 secret**
4. `scripts/merge-books.mjs` 在 CI 里跑：合并 articles（按 threadId + updatedAt 去重）+ 每 device 一份 chapter（`book/<proj>/chapter.<device>.md`）+ 重生 `book/index.md` + `book/_meta/timeline.md`
5. 删除：`src/digest/runners/github-models.ts`、`src/github-models-catalog.ts`、`src/digest/model-limits.ts`、对应 tests
6. Config schema 的 `runner` enum 去掉 `"github-models"` 和 `"github-action"`，剩 `"claude-cli"` + `"anthropic-api"`（后者保留 stub for Sprint 5）
7. `npm test` 全绿
8. README + roadmap 文案与新设计一致

---

## 详细任务拆解

### Task 2 — 删除 github-models 路径

- [ ] 2.1 删 `src/digest/runners/github-models.ts`
- [ ] 2.2 删 `src/github-models-catalog.ts`
- [ ] 2.3 删 `src/digest/model-limits.ts`（整个文件，包含 `budgetForGithubModels` /
      `tokensToChars` / `truncatePromptForGithubModels` 都用不到了；anthropic-api
      future-runner 自己有 token API）
- [ ] 2.4 `src/digest/runner.ts`:
      - 删 `import { runGithubModels }` 一行
      - `case "github-models"` 整 case 删
      - `case "github-action"` 整 case 删（包括 throw 那段）
      - 留 `claude-cli` + `anthropic-api`
- [ ] 2.5 `src/config.ts`:
      - `runner` enum: `["claude-cli", "anthropic-api"]`
      - `DEFAULT_THREADING_CONCURRENCY` 注释移除"github-action 撞限流"那段
      - 可以恢复默认 `4`（claude-cli 没有 free-tier rate limit）
- [ ] 2.6 `src/cli.ts`: 删 `--all-models` flag + 对应 opts 字段
- [ ] 2.7 `src/commands/init.ts`:
      - `InitOptions.allModels` 字段删
      - 传给 `runInitWizard()` 的 `{ allModels }` 删
- [ ] 2.8 `src/commands/sync.ts`:
      - 删 line 262-264 的 `runner === "github-action"` 跳过分支
      - sync 入口本来就只调 createRunner，干净
- [ ] 2.9 删测试:
      - `tests/digest/runners/github-models.test.ts`
      - `tests/github-models-catalog.test.ts`
      - `tests/digest/model-limits.test.ts`
      - `tests/e2e/digest-with-github-models.test.ts`（如有）
- [ ] 2.10 grep 全仓 `github-models|github-action|VIBEBOOK_CI|VIBEBOOK_PASSPHRASE`，逐个清；
      `VIBEBOOK_PASSPHRASE` 还需要保留（claude-cli 也用加密；只是不再被 workflow yaml 写）
- [ ] 2.11 `npm run build` 通过；`npx vitest run` 还会爆错（wizard/workflow 测试），
      在 task 3-5 处理

### Task 3 — Wizard 重构

- [ ] 3.1 `WizardAnswers` 接口:
      - `runner: "claude-cli"`（去掉 `"github-action"`）
      - 新增 `enableAggregateCI: boolean`
      - 删 `runnerModel` 字段没必要也行（claude-cli 用空字符串就好）—— **保留**让 user 可选 `--model`
- [ ] 3.2 `runWizard`:
      - 删 Q6 的 promptChoice（直接 `runner = "claude-cli"`）
      - 删 Q7 的 fetchGithubModelsCatalog 分支
      - Q7 改为 `prompt("Q7: Model name (blank = claude default)", "")`
      - **新 Q8**: `promptYesNo("Q8: Enable CI book aggregation across devices?", false)` →
        only ask when `syncToRemote` is true（local-only 模式没 CI 可言）
- [ ] 3.3 `applyWizardAnswers`:
      - 写 config 时 `runner: "claude-cli"`
      - 末尾 hint 区分 `enableAggregateCI`:
        - true → "Next: 1) vibebook sync  2) vibebook workflow init"
        - false → "Next: vibebook sync"
      - 删 "set VIBEBOOK_PASSPHRASE secret" 那一行（CI 不再调 LLM 不需要 secret）
- [ ] 3.4 删 `RunWizardOptions.allModels` 字段及全部使用
- [ ] 3.5 测试更新 (`tests/commands/init-wizard.test.ts`):
      - 删跟 catalog / Q7 picker / allModels 相关的断言
      - 加新的 Q8 断言

### Task 4 — 新 workflow yaml + merge-books.mjs

- [ ] 4.1 新增 `assets/workflows/vibebook-aggregate.yml`:
      ```yaml
      name: vibebook aggregate book
      on:
        push:
          branches-ignore: [main]
        workflow_dispatch:
      permissions:
        contents: write
      concurrency:
        group: vibebook-aggregate
        cancel-in-progress: false
      jobs:
        aggregate:
          runs-on: ubuntu-latest
          timeout-minutes: 10
          steps:
            - uses: actions/checkout@v4
              with:
                ref: main
                fetch-depth: 0
            - uses: actions/setup-node@v4
              with: { node-version: "20" }
            - name: Configure git identity
              run: |
                git config user.name  "vibebook-bot"
                git config user.email "vibebook-bot@users.noreply.github.com"
            - name: Aggregate
              run: node scripts/merge-books.mjs
            - name: Push
              run: git push origin HEAD:main
      ```
- [ ] 4.2 删旧 `assets/workflows/vibebook-digest.yml`
- [ ] 4.3 新增 `assets/scripts/merge-books.mjs`:
      - 用 `child_process.execSync('git', ['for-each-ref', ...])` 列所有非 main 分支
      - 对每个 device 分支:
        - `git show <branch>:.vibebook/index.book.json`（可能不存在 → skip）
        - `git show <branch>:book/<project>/articles/<file>.md`（每篇 article）
        - `git show <branch>:book/<project>/chapter.md` → 写到 main 的
          `book/<project>/chapter.<device>.md`
      - Articles dedupe:
        - 解析所有 device 的 BookEntry，按 threadId 分组
        - 每组取 `updatedAt` 最大那个 device 版本
        - 把那个 device 的 article md 写到 main 的相同路径
      - 重新生成 `book/index.md`（列章 + 每章列文）和 `book/_meta/timeline.md`
        （全局时间线）—— 这部分 logic 可以从 `src/digest/toc.ts` 抄一份独立的
        ESM 版本（CI 不能 import TS）
      - `git add book/` + commit "vibebook aggregate: ..." + 退出（push 在 yaml 里做）
- [ ] 4.4 配套：把 `assets/scripts/merge-books.mjs` 加进 `package.json` 的
      `files` 字段，确保 npm pack 带上
- [ ] 4.5 单测 (`tests/scripts/merge-books.test.ts`):
      - 准备 fake bare repo + 两个 device 分支各推 1 个 project
      - 跑 mjs script，断言 main 上有去重后的 articles + 各 device 的 chapter

### Task 5 — `vibebook workflow init` refactor

- [ ] 5.1 `src/commands/workflow.ts`:
      - 模板路径改 `vibebook-aggregate.yml`
      - 也写 `scripts/merge-books.mjs` 进 user 的仓库根（注意是 user repo，不是
        vibebook 自己；resolve template 路径同样要 fall back 多个候选）
      - 删 salt write 逻辑（不再需要 — CI 不调 LLM）
      - 删 "set VIBEBOOK_PASSPHRASE secret" 那一段
      - 改 commit message 为 "vibebook: add aggregate-book workflow"
      - 自动 commit + push 行为保留（已是好设计）
- [ ] 5.2 `src/cli.ts`: 描述更新
      - `"Manage the GitHub Action that aggregates device branches into main"`
      - `"init"` 子命令 description 同步
- [ ] 5.3 测试更新 (`tests/commands/workflow.test.ts`):
      - 删跟 salt / VIBEBOOK_PASSPHRASE / runnerModel 替换相关的断言
      - 新断言: 写出来的 yaml 含 "aggregate" + "branches-ignore: [main]" + 不含 "models: read"
      - 新断言: `scripts/merge-books.mjs` 也被写进 user repo
      - 集成测试: bare remote + workflow init 后 main 分支上能看到 yaml + script

### Task 6 — 测试和文档

- [ ] 6.1 `npm test` 全绿
- [ ] 6.2 `npm run build` 通过 + `tsc` 无 warn
- [ ] 6.3 `README.md` "Run digest in GitHub Actions" 一节改成 "Aggregate book/
      across devices"，去掉所有 GitHub Models / 8K cap / VIBEBOOK_PASSPHRASE
      / gpt-4o-mini 字眼
- [ ] 6.4 `docs/superpowers/roadmap.md`:
      - Sprint 4 (main 聚合) 标记 in-progress / 改细节为"机械合并"
      - Sprint 5 (多 runner) 大改 — github-models 已删，只剩 anthropic-api
        作为 stub；可降级到 Sprint 7 的 polish bucket
      - "已废弃"区追加: "github-models runner — 因免费 tier 8K input cap 不可用"

### Task 7 — 收尾

- [ ] 7.1 npm version patch + commit
- [ ] 7.2 `git push origin main --tags`
- [ ] 7.3 `npm publish`
- [ ] 7.4 user 在 work-memory 仓库:
      - 升 vibebook 到新版本
      - 删旧的 `.github/workflows/vibebook-digest.yml`
      - 跑 `vibebook workflow init` 装新 aggregate yaml + merge-books.mjs
      - 触发一次 workflow，看 main 是否真合出 book

---

## 实现顺序提醒

按 task 顺序串行做最稳。Task 2 删完所有引用后 build 会爆，**继续做 task 3-5**
直到把所有引用替换完，build 才会再次过。中途不要 commit 半成品，全做完一次性
commit。

如果 session 中途超时:
- 在每个 step 前面 `[ ]` 改 `[x]` 表示已完成
- 没做完的 step 加备注（"已写到 X，未跑测试"等）
- 下个 session 继续

## 不在本 sprint 里的事

- anthropic-api runner 实做（保留 stub；Sprint 5 / Sprint 7 再说）
- judge-merge / 多步 article pipeline / 增量 chapter（Sprint 6）
- 静态站点 / llmwiki（原 Sprint 6 → 现在因为 main 上有完整 book，可以直接接
  GitHub Pages，下个 sprint）
