# Sprint 3 — 收尾打磨 + 评估脚手架 + anthropic-api

**Date:** 2026-04-22
**Status:** Ready to execute
**Owner:** Yue
**Roadmap:** `docs/superpowers/roadmap.md` → Sprint 3
**Estimated effort:** 1 session（如超时 → 按 step 打勾接续）

---

## 背景（next session 必读）

Sprint 2 已完成（含一票 roadmap 外的强化：input 过滤、中文 prompt、insightScore、
isolated cwd、auto-recovery、`--reset`/`--redo`、github-models runner、init wizard、
workflow CLI）。User 重跑 `digest --reset` 后已认可内容质量。

剩下的就是**收口**：评估脚手架（让"质量好不好"可量化、回归可见）+ 三个小补丁
+ 一个真 stub runner（anthropic-api）。

不要在本 sprint 引入新架构。任何"如果 X 不行就换 Y"的想法 → 写进 Sprint 6。

---

## 验收标准

1. `npm test` 全绿；新增 `tests/digest/quality-eval.test.ts` 跑评估脚本
2. `scripts/eval-digest.mjs` 在 fixture 上输出 markdown 报告（覆盖率 / 字数 /
   结构合规率）
3. `anthropic-api` runner 在 mock fetch 下测试通过；user 手测一次
4. `.gitignore` 覆盖：`docs/superpowers/plans/*`、`.claude/worktrees/`、
   `.claude/projects/`（如有）、其它 AI 副产物
5. 全仓 grep `\bmemvc\b`（区分大小写）= 0（豁免：`.memvc/` 路径字面、
   git history 字面引用、`MEMVC_CI` 等遗留 env 名 backcompat）
6. wording 修正：`runner 'github-action' only works ...` → 中性说明

---

## 任务拆解

### 3.1 仓库卫生（小，先做掉）

- [ ] 3.1.1 加 `.gitignore` 条目
  - `docs/superpowers/plans/*.md`（仅本仓库 vibebook 自身的 plans 不入库；
    用户仓库的 prompts 不受影响）
  - 例外：roadmap.md / specs/ 仍要入库
  - 验证：`git status` 不再列 plans/
- [ ] 3.1.2 全仓 `memvc` 字符串审计
  - `rg -i 'memvc' --type-not lock` 列出
  - 分类：(a) 必须保留（`.memvc/` 数据目录、env 名 backcompat、URL 字面）
    (b) 该改成 `vibebook`（README、注释、错误信息、wording）
  - 改 (b) 类
  - 验证：`rg '\bmemvc\b' src/ docs/ assets/ README.md` 只剩白名单项
- [ ] 3.1.3 wording 修正
  - 找到 `runner 'github-action' only works when run inside the GitHub Action`
    （`src/digest/runner.ts` 或 runners/）
  - 改成：`runner 'github-action' is for CI only — skipped (not callable locally)`
  - 找到 sync 中类似 `runner='github-action' locally` 的报错也一起改

### 3.2 `anthropic-api` runner 实做

- [ ] 3.2.1 加依赖：`npm i @anthropic-ai/sdk`
- [ ] 3.2.2 重写 `src/digest/runners/anthropic-api.ts`
  - 从 env 读 `ANTHROPIC_API_KEY`；缺失时 `RunResult.ok=false` 友好报错
  - 单条 user message：prompt 自己拼
  - 默认 model：`claude-sonnet-4-6`（roadmap 注：当前最新；可被 `runnerModel` 覆盖）
  - 默认 timeout 180s（与 claude-cli 对齐）
  - 处理 streaming or 非 streaming（先非 streaming 简单）
  - 处理超时 / 网络错误 / API 错误，转 `RunResult.ok=false`
  - 不需要 caching、tool use、thinking（本管线只要 text in / text out）
- [ ] 3.2.3 测试 `tests/digest/runners/anthropic-api.test.ts`
  - mock `Anthropic` SDK（或 mock global fetch + dependency injection）
  - case：成功返回 text、API 错误、缺 key、超时
- [ ] 3.2.4 `createRunner` 接 `anthropic-api` 分支（应已存在；确认）
- [ ] 3.2.5 README 更新：runner 列表去掉 `(stub)` 标记；记一句"需 ANTHROPIC_API_KEY"
- [ ] 3.2.6 user 手测：
  - `export ANTHROPIC_API_KEY=...`
  - `vibebook digest --redo --runner anthropic-api`（先确认 CLI 是否支持
    `--runner` 临时覆盖；不支持则改 config 跑）
  - 看一篇 article 是否生成成功

### 3.3 质量评估脚手架

> 目的：给"book 质量"一个可重复的尺子。Sprint 4 静态站点之后还能拿来回归。

- [ ] 3.3.1 fixture：`tests/fixtures/quality/`
  - 3 个有代表性 thread（每个对应 2-4 个 session 的 raw md）：
    - thread A：单 session 简单问答（应被 SKIP 或写出短文）
    - thread B：跨 session 调试一个具体 bug（应写成有"踩过的坑"的中等文）
    - thread C：跨 session 设计 + 实现一个 feature（应写成结构完整的长文）
  - fixture 数据可以从 `~/memvc-repo/raw_sessions/` 摘 3 段真实 md
    （脱敏：把任何 token / 用户名 / 公司内部代号替换成占位）
- [ ] 3.3.2 `scripts/eval-digest.mjs`
  - 输入：fixture 目录
  - 步骤：
    a. 拼成 in-memory NormalizedSession[]
    b. 跑 batcher → threading → article（用环境变量指定的 runner，默认 claude-cli）
    c. 对每篇产出 article 计算指标
    d. 输出 `eval-report-<timestamp>.md` 到 `tmp/`（gitignore）
  - 指标：
    - **结构合规率**：是否含 `## 主要产出` / `## 知识积累` / `## 踩过的坑` /
      `## 附：原始对话` 四节
    - **字数**：每篇 / 全部
    - **关键词覆盖**：fixture 自带 `expected_keywords.json`，统计命中率
    - **SKIP 命中率**：thread A 是否如预期 SKIP
  - 不调 LLM 当裁判（Sprint 6 再说）；先靠机械指标
- [ ] 3.3.3 `tests/digest/quality-eval.test.ts`
  - 用 mock runner（返回固定 markdown）跑一次评估脚本，断言报告 schema
  - 不在 CI 跑真 LLM；真 LLM 跑由 user 本地手动触发
- [ ] 3.3.4 `package.json` 加 npm script
  - `"eval": "node scripts/eval-digest.mjs"`
  - README "Development" 一节加一行说明

### 3.4 真实数据回归 + Baseline 记录

- [ ] 3.4.1 user 在 `~/memvc-repo` 跑一次 `vibebook digest --reset`（claude-cli runner）
- [ ] 3.4.2 跑 `npm run eval` 用 claude-cli runner 一次、anthropic-api 一次、
  github-models 一次（如果都有 key）
- [ ] 3.4.3 把三份 `eval-report-*.md` 汇总进
  `docs/superpowers/2026-04-22-runner-quality-baseline.md`
  - 一张对比表 + 一段结论（哪个 runner 适合什么场景）
  - 这是 Sprint 5 / Sprint 6 后续打磨的基线

### 3.5（可选，仅在 3.4 显示 chapter 弱时做）chapter prompt 扩写

- [ ] 3.5.1 把 `assets/prompts/chapter.md` 从 9 行扩到 30-40 行
  - 加 few-shot 一例
  - 强化"列举每篇 article + 整体叙事 + 时间跨度"
  - 加"不要漏掉任何 article 的标题"硬规则
- [ ] 3.5.2 bump `CHAPTER_VERSION`，让下次 sync 自动批量重写
- [ ] 3.5.3 `npm run eval` 复跑一次，确认结构合规率不退化

---

## 不在本 sprint 里的事（防止 scope creep）

- judge-merge / 多步 article pipeline / LLM 当裁判 → Sprint 6
- 静态站点 → Sprint 4
- main 聚合 → Sprint 5
- 加密去留决策 → Sprint 6
- 改分支模型 → 永远不

---

## 接续协议（如果 session 中途超时）

- 在每个 step 前面的 `[ ]` 改成 `[x]` 表示已完成
- 没做完的 step 加备注："（已写到 X，未跑测试）"或类似
- 下个 session 开工：读 roadmap.md → 读本文件 → 从第一个未打勾的 step 接
- 不要从头重做已打勾的 step
