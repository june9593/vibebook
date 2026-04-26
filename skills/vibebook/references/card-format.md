# Card format (atomic insight)

```markdown
---
title: <一句话讲清这是什么 insight>
slug: <type>-<descriptive-slug>
type: gotcha | pattern | decision | howto | tool
project: <project-slug> | _global
created: YYYY-MM-DD
tags: [domain, type]            # 1-3 ideal, ≤5 max
---

(一段或几段话讲清这个 fact / pattern / decision。包含 wikilink 嵌句中
解释 relationship。)

参考:[[chronicle/<source-thread-slug>]]
```

Slug type prefix:

- `gotcha-<具体名>` — 一个坑 (UAF / order dependency / 配置陷阱)
- `pattern-<具体名>` — 一个可复用的做法
- `decision-<具体名>` — 一个架构决策 (含理由)
- `howto-<具体名>` — 一个具体怎么做
- `tool-<具体名>` — 工具用法/配置 (`tool-claude-code-skill-loading`)

Per-project vs `_global/`:

| 卡片关于... | 放哪 |
|---|---|
| 跟具体 codebase / 业务 / 公司项目绑定 | `book/<project>/cards/` |
| 跟工具 / 语言 / OS / 通用 best-practice 绑定 | `book/_global/cards/` |
| 二者都涉及 | per-project (主),`_global/` 留 wikilink 入口 |

Hard rules:

1. **Atomic** — 一张卡一个事。能拆就拆。
2. **Non-obvious** — "下次做类似事会失去这个 insight 吗?不会就别写。"
   API 文档里有的东西不写。
3. **Own words** — 用自己的话复述。**不要粘 API 文档原文 / 错误信息原文**.
   如果你只能粘原文 → 说明你没真懂 → 别写。
4. **Fact Hygiene** — 写完每张卡自检三问 (一条不过关就重写):
   - **WHO** — 提到的项目/库/工具是用户自己的还是外部的?陌生人能分清吗?
   - **WHAT-WHEN** — 数字 (耗时/token/commit hash) 是否绑定到具体场景?
   - **RELATIONSHIP** — "基于/参照/借鉴" 这类词展开成具体关系
     (fork from / benchmark against / inspired by / extends / contradicts)。
5. **Dedup before write** — `Glob book/<project>/cards/*.md` +
   `Glob book/_global/cards/*.md`,看有没有相似的:
   - 内容增量 → `action: "update"` 在已有卡片末尾追加。
   - 内容重复 → 跳过。
6. **Wikilink in context** — `[[link]]` 必须嵌在解释关系的句子里。
   ❌ `Related: [[x]]`
   ✅ `这与 [[gotcha-foo]] 的修法相反 — 那里用 widget 监听,这里用 NSWindow API`
