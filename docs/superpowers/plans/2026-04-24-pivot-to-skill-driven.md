# Sprint 4 — Pivot 到 skill-driven + 加 page schema + 偷 memex prompt 片段

**Date:** 2026-04-24
**Status:** Plan ready, code change is the next session's job
**Owner:** Yue
**Roadmap:** retire 当前 Sprint 3 的"评估脚手架"路线（不再适用），改 Sprint 4
为本计划。

---

## 背景

User 对 vibebook 当前 article 产出**不满意**。深挖 3 个 sibling repo 之后定下
3 个借鉴方向（A + B + 偷 C 的 prompt）：

| 方向 | 来源 | 核心 |
|---|---|---|
| **A** | `/Users/yueliu/edge/logex` | LLM 调用从"spawn `claude -p` 子进程"改成"当前 Claude session 自驱动 + slash command" |
| **B** | `/Users/yueliu/edge/edge-dev` | article/chapter/index 加 YAML frontmatter + Related Pages backlink + index 是 catalog |
| **C** | `/Users/yueliu/edge/memex` | 偷 retro/best-practices 的 prompt 片段（Fact Hygiene Check / atomic / own-words） |

**user 明确表示不要**：memex 的卡片存储 / 自动总结 / SessionStart hook — 那些是
另一个 product 的形状，vibebook 走自己的路。

---

## 当前 vibebook 痛点（pivot 要解决的）

1. **质量天花板低**：`spawn('claude', ['-p', ...])` 子进程是无上下文的、新 session
   起来的 Claude，只看到我们拼好的 prompt + sessionsMd。它不知道你这一年在
   做什么、不知道你最近聊过什么，写出来的文章是"读完一段对话能写的最普通版本"。
2. **不可中断 / 不可调**：article 阶段一篇一篇 spawn，跑半天才知道哪些质量差。
3. **Article 内容套路化**："主要产出/知识积累/踩过的坑" 三段往往写得空洞；
   缺 fact hygiene → 出现"对标 X / 借鉴 Y"这种含糊的指代。
4. **没有 article 之间的关系**：每篇 article 是孤岛，没 frontmatter，没 related
   links；翻起书来跳不动。
5. **`book/index.md` 是 flat TOC**，不是 catalog；扫一眼不知道哪篇文章值得读。

---

## 新设计

```
┌──────────────────────────────────────────────────────────────┐
│ User 在 Claude Code 里输入 /vibebook                          │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ skill: skills/vibebook/SKILL.md                              │
│  9 个步骤,告诉 Claude 怎么走完整个 digest 流程                │
└──────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  vibebook prepare    Claude 自己写        vibebook publish
  (pure code)         article + segment    (pure code,幂等 upsert)
   ↓ JSON              ↑ 在当前 session     ↓ 写入 git book repo
   chunkSummaries      看完整 context       chunkIndices 去重
   segmentationPrompt
```

**核心翻转**: 把 spawn `claude -p` 全部干掉。LLM 工作由**当前正在跟 user 聊天的
Claude**做（带完整 context、记得 user 这一年在干嘛）。我们只提供：
- `vibebook prepare` 把 raw jsonl 处理成 LLM 友好的元数据（pure code）
- `vibebook publish prepare-match / execute` 把 LLM 输出的文章幂等写入 book（pure code）
- `skills/vibebook/SKILL.md` 教 Claude 走完整流程

LLM 也不再用 spawn，所以：
- ❌ `src/digest/runners/claude-cli.ts` 删
- ❌ `src/digest/runner.ts` 简化（也许就剩 anthropic-api 一个 future runner）
- ❌ `src/digest/with-isolated-cwd.ts` + `sweepScratchDirs` 删（不再 spawn 不需要扫垃圾）
- ❌ `src/digest/threading.ts` 现在的 batch + 并发 + 429 retry 全删（不再有 LLM 调用)
- ❌ `src/digest/article.ts` 整个 generateArticle 删
- ❌ `src/digest/chapter.ts` 整个 generateChapter 删
- ❌ `assets/prompts/{thread,article,chapter}.md` 这三个 prompt 直接搬进 SKILL.md
  的 步骤说明里给当前 Claude 看
- ✅ `src/digest/batcher.ts` 改成 `prepare.ts` 的 chunk + score 逻辑
- ✅ `src/digest/book-index.ts` 加 frontmatter 字段
- ✅ `src/digest/toc.ts` 改成 catalog 格式（B 方向）

---

## 验收标准

1. User 在 Claude Code 里跑 `/vibebook` → 走完 9 步 → 至少一篇 article + 一章
   chapter 写到 `book/<project>/`，frontmatter 完整，有 Related Pages
2. 同一 session 重跑 `/vibebook` 不重复创建 article（chunkIndices 去重生效）
3. `vibebook` CLI 暴露：`prepare`, `publish prepare-match`, `publish execute`,
   `list`, `show`, `init`, `sync`, `workflow init`（删掉 `digest` 系列命令）
4. `assets/prompts/*` 改造成 SKILL.md 的几段 inline instructions（不再独立文件）
5. Article 输出含 YAML frontmatter（title/created/updated/tags/sources/relatedThreadIds）
6. `book/index.md` 是 catalog 而不是 flat TOC：每章一个 H2，下面 bulleted
   `- [<title>](path) — one-line desc`
7. 每篇 article 末尾有 `## Related Pages` 段（≥0 项；空了写 "_暂无相关_"）
8. memex 的 Fact Hygiene Check 注入 article 写作 instructions（在 SKILL.md 步骤 6）
9. `npm test` 全绿；删掉所有 LLM-mock 测试（runner / batcher 并发 / 429 retry 等
   不再适用）
10. README 重写"Daily use"段，主推 `/vibebook` slash command 而不是 `vibebook sync`

---

## 任务拆解

### Task 1 — Spike: 验证可行性（先做，不破坏现有代码）

- [ ] 1.1 在 vibebook 仓库**新建** `skills/vibebook/SKILL.md` 草稿，按 logex
      9 步结构写一遍（不接 vibebook 自己代码也行，只验证结构可读）
- [ ] 1.2 找一个真实 jsonl session（user 自己 `~/.claude/projects/...`）手动
      走一遍：把 sessionsMd 直接喂给当前 Claude（即"不 spawn 子进程，让我
      Claude 自己读"），看产出质量是否真的比 v0.1.19 好
- [ ] 1.3 拍板：质量提升明显 → 进 Task 2；不明显 → 重新评估方向

### Task 2 — Pure-code 端: prepare + publish 子命令

设计 contract：

**`vibebook prepare <sessionId> [--mode article|chapter]`** stdout JSON：
```ts
{
  sessionId: string,
  mode: "article" | "chapter",
  chunkSummaries: Array<{
    index: number,        // 1-based
    startTs: string,
    endTs: string,
    score: number,        // insightScore from existing session-signal.ts
    project: string,
    preview: string,      // ≤300 chars
    messageCount: number,
  }>,
  segmentationPrompt: string,  // ready-to-paste prompt for the in-session LLM
  meta: { entries, messages, chunks, signalChunks, startTime, endTime }
}
```

**`vibebook publish prepare-match --book-path <path> --thread-id <id> --articles <jsonPath>`**

输入: LLM 写出来的 article JSON 数组：
```ts
[{ title, body, tags, chunkIndices, sources, project, slug? }]
```

逻辑（抄 logex `publish.ts` 的 prepare-match）：
- 读 `BookIndex.threads`，找 `chunkIndices` 重叠 > 50% 或 title 相似的现有 entry
- 输出 `{ needsLlm: boolean, decisions?, matchingPrompt? }`
- needsLlm=true 时返回一个 prompt 让 LLM 决定 update/insert
- 都不重叠 → `{ needsLlm:false, decisions:[insert,...] }`

**`vibebook publish execute --book-path <path> --decisions <jsonPath>`**

实际写文件 + commit + 更新 BookIndex。Preserve 现有 article 的 createdAt /
heroImage / 其它 metadata。

任务清单：
- [ ] 2.1 移植 logex `parse.ts` → `src/digest/jsonl-parse.ts`（可能可用现有
      adapter 代替，看代码）
- [ ] 2.2 移植 logex `chunk.ts`（按对话边界 chunk + score）→ `src/digest/chunk.ts`
      把现有 `batcher.ts` 替换掉
- [ ] 2.3 移植 logex `segment.ts`（buildChunkSummaries + buildSegmentationPrompt）
      → `src/digest/segment.ts`
- [ ] 2.4 新 `src/commands/prepare.ts` — wire 起 chunk + segment + 输出 JSON
- [ ] 2.5 新 `src/commands/publish.ts` — `prepare-match` + `execute` 子命令
- [ ] 2.6 `src/cli.ts` 加 `prepare` + `publish` 子命令
- [ ] 2.7 删 `src/digest/runners/`（整个目录）+ `src/digest/runner.ts` +
      `src/digest/with-isolated-cwd.ts` + `src/digest/article.ts` +
      `src/digest/chapter.ts` + `src/digest/threading.ts` + `src/digest/concurrency.ts`
- [ ] 2.8 `src/digest/orchestrator.ts` 大幅简化（只剩 plan + toc + bookIndex 操作）
- [ ] 2.9 `src/commands/digest.ts` 删（被 prepare/publish 取代）；`vibebook sync`
      改成"只做 extract + push"，digest 留给 `/vibebook` skill 触发
- [ ] 2.10 删对应 tests：`runner.test.ts`、`with-isolated-cwd.test.ts`、
      `article.test.ts`、`chapter.test.ts`、`threading.test.ts`、`concurrency.test.ts`、
      `redo.test.ts`、`digest.test.ts`
- [ ] 2.11 加新 tests：`prepare.test.ts`（fixture jsonl → 断言 chunkSummaries
      shape）、`publish.test.ts`（mock LLM decisions → 断言 article 落地 +
      BookIndex 更新 + chunkIndices 去重）

### Task 3 — Page schema (B 方向)

任务清单：
- [ ] 3.1 `src/digest/book-index.ts` `BookEntry` 加字段：
      ```ts
      createdAt: string;       // ISO date, set on first article write, never mutated
      tags: string[];          // lowercase, 1-3 ideal, ≤5 max
      sources: string[];       // session relativePath array, repo-rooted
      relatedThreadIds: string[]; // for Related Pages section
      ```
- [ ] 3.2 `src/commands/publish.ts` 写 article 文件时，emit YAML frontmatter
      header（参考 edge-dev SCHEMA.md lines 53-60）：
      ```yaml
      ---
      title: <title>
      created: <createdAt YYYY-MM-DD>
      updated: <updatedAt YYYY-MM-DD>
      tags: [...]
      sources: [...]
      ---
      ```
- [ ] 3.3 `src/digest/toc.ts` `renderBookIndex` 改成 catalog 格式：
      - YAML frontmatter (title/created/updated)
      - `# 笔记本` + 一行汇总
      - `## 章节` 每个 project 一个 bullet：`- [<project>](path) — N 篇 · 最近 <date>`
        嵌套 top 3-5 article links（用 frontmatter title + 一行 desc）
      - `## 索引`: 链接到 `_meta/timeline.md`
- [ ] 3.4 `src/digest/toc.ts` per-chapter `timeline.md` 改成同样 catalog 风格
      （已有 article frontmatter 后能直接渲染 desc 行）
- [ ] 3.5 `src/digest/parse-frontmatter.ts` 新 helper，读已有 article md 的
      frontmatter（catalog 渲染要用）
- [ ] 3.6 测试：`toc.test.ts` 更新断言（snapshot frontmatter + catalog 行）；
      新加 `parse-frontmatter.test.ts`

### Task 4 — Skill + slash command（A 方向，把 LLM 工作搬到 in-session）

任务清单：
- [ ] 4.1 新 `skills/vibebook/SKILL.md`，YAML 头：
      ```yaml
      ---
      name: vibebook
      description: Digest synced Claude/Copilot sessions into a book chapter+articles. Triggers `/vibebook`.
      ---
      ```
      9 步内容（参考 logex skill.md，改成 vibebook 语义）：
      1. 找最近的 jsonl 或 user 指定的 sessionId
      2. `bash` 块：`vibebook prepare <id> --mode article > /tmp/vibebook-prepare.json`
      3. 读 `/tmp/vibebook-prepare.json` 的 `segmentationPrompt`，让自己执行（产
         `groups` JSON 写到 `/tmp/vibebook-segments.json`）
      4. 给 user 看候选 thread 列表，问要不要写
      5. 对每个 thread，**inline 写文章**到 `/tmp/vibebook-articles.json`
         （按下面的写作规范）
      6. **写作规范**（这里偷 memex 的 Fact Hygiene Check）：
         ```
         ## 主要产出 - 列实际改了什么 / 决定了什么
         ## 知识积累 - 每条满足 non-obvious test:
            "如果不写下来,下次做类似事情你会遗失这个 insight 吗?
             不会 → 别写"。用自己的话(Feynman),不要粘 API 文档。
         ## 踩过的坑 - 每条写完自检 WHO/WHAT-WHEN/RELATIONSHIP 三问
         ## 附:原始对话 - sources 链接
         ```
      7. `bash` 块：`vibebook publish prepare-match --book-path ... --articles ...`
      8. 读返回的 `needsLlm`：true 就执行 matchingPrompt 决定 update/insert
      9. `bash` 块：`vibebook publish execute --decisions ...`，commit & push
- [ ] 4.2 偷 logex `hooks/session-end.sh` + `hooks/hooks.json`：放
      `hooks/session-end.sh` 内容只 echo "💡 sync 一下并 /vibebook 总结这次 session?"
      （**简版**，不抢戏）。register 在 `hooks/hooks.json` 的 Stop hook
- [ ] 4.3 `package.json` 加 `claude-plugin` 字段：
      ```json
      "claude-plugin": {
        "hooks": "./hooks/hooks.json",
        "skills": "./skills/"
      }
      ```
- [ ] 4.4 `.claude-plugin/` 目录 — vibebook 自己作为 Claude Code plugin 发布的
      meta 文件
- [ ] 4.5 `assets/prompts/{thread,article,chapter}.md` 删除（内容已搬入 SKILL.md）

### Task 5 — Wizard + Init 调整

任务清单：
- [ ] 5.1 `init-wizard.ts` Q5 改为：`Use /vibebook in Claude Code to digest sessions
      into a book? (y/n)` —— y 时往 SKILL.md 路径走，n 时只 sync 不 digest
- [ ] 5.2 删 Q6 model 选择 + verifyRunner（不再 spawn claude，没必要 ping）
- [ ] 5.3 `init` 末尾提示：
      ```
      Next steps:
        1. vibebook sync                  # extract + push raw_sessions
        2. /vibebook                       # in Claude Code: digest into book
        (3. vibebook workflow init        # CI cross-device aggregation, optional)
      ```

### Task 6 — Docs + cleanup

- [ ] 6.1 README "Daily use" 重写：从 `vibebook sync && vibebook digest` 改成
      `vibebook sync && /vibebook`
- [ ] 6.2 README 新增 "How vibebook differs from logex/memex" 段（user 同事的
      作品；致谢）
- [ ] 6.3 roadmap.md 收尾 Sprint 3，开 Sprint 4 = 本 plan
- [ ] 6.4 `npm version major`（破坏性 API 变化，从 0.1.x 跳 0.2.0）
- [ ] 6.5 commit + push tag；**不 publish**（user 明确 "等完全改好再 publish"）

---

## 风险 & 取舍

| 风险 | 缓解 |
|---|---|
| User 不在 Claude Code 里跑 vibebook 怎么办？ | `vibebook sync` 仍然能用（同步 raw + push）。LLM-driven digest 必须在 Claude Code 里。这是设计取舍：放弃"独立 CLI 跑 digest" 换"质量天花板抬高" |
| 现有 user（如果有）配置中是 `runner: claude-cli` | wizard 自动 migrate 配置文件；删 `runner` 字段；`vibebook sync` 不报错 |
| logex 的 `chunkIndices` 去重 vs vibebook 的 `threadId` 去重 | logex 的更精细（按 chunk 重叠匹配），可保留 threadId 作为辅助 key；hybrid： 先按 threadId 找候选，再用 chunkIndices 决定 update/insert |
| 删大量代码会不会丢功能？ | `--reset` / `--redo` 这种 recovery 逻辑可以由 `/vibebook` 自然代替（重跑 skill 即可）；但 `digest --reset` 这种 destructive 命令保留为 `vibebook book reset` 给用户兜底 |
| Skill model 让 in-session Claude 写大量 markdown 进 /tmp，是不是吃 user context？| 是。但比 spawn 子进程的硬约束（200K vs 8K）好得多；user 可以在新 Claude session 里跑 `/vibebook`，专门给这件事 |

---

## 实现顺序提醒

按 Task 1 → 2 → 3 → 4 → 5 → 6 顺序串行做。Task 1 spike 失败就不要继续。

Task 2 删完 LLM 路径后 build 会爆，**继续 Task 3-4** 直到所有引用替换完。
中途不要 commit 半成品，全做完一次性 commit。

如果 session 中途超时:
- 在每个 step 前面 `[ ]` 改 `[x]` 表示已完成
- 没做完的 step 加备注
- 下个 session 继续

## 参考文档

- 三个 sibling repo brief 在 conversation 里（agentId `ad9aee9f56d4d73b2`、
  `a85eaf8dd4f2e76c3`、`a7fad867e0222a18e`、`a1653320e96534f95`、
  `af58bc3330589b249`、`aa389c3f8a3c1e266` 的 results）
- logex 关键文件: `/Users/yueliu/edge/logex/{skills/logex/skill.md,src/pipeline/{prepare,publish,segment,chunk,prompt}.ts,hooks/{session-end.sh,hooks.json}}`
- edge-dev 关键文件: `/Users/yueliu/edge/edge-dev/{SCHEMA.md,index.md,.github/agents/edgedev.agent.md}`
- memex 关键文件: `/Users/yueliu/edge/memex/skills/{memex-retro/SKILL.md,memex-best-practices/SKILL.md}`

## 不在本 sprint 里的事

- 静态站点 / llmwiki（原 Sprint 4，挪到 Sprint 5）
- anthropic-api runner 实做（原 Sprint 5，挪到 Sprint 6 — 而且 skill 模型下
  这个 runner 价值大降，可能彻底取消）
- 评估脚手架 fixture（原 Sprint 3.3 — skill 模型下质量评估方式完全变了，
  原 fixture 设计不再适用）
