# Chronicle format (4-section)

```markdown
---
title: <human-readable, ≤30 chars>
created: YYYY-MM-DD
updated: YYYY-MM-DD
project: <project-slug>
threadId: <slug>
sessionIds: [<shortId>, <shortId>, ...]
tags: [domain, scope, type]    # 1-5 tags
relatedTopics: [topics/<slug>.md, ...]
relatedCards: [cards/<slug>.md, ...]
---

# <title>

## What — 做了什么
- <按时间或任务粒度列点;尽量保留 commit hash / 文件路径 / 命令行>
- ...

## Why — 为什么要做
- <立项动机 / bug 触发场景 / 上游决定 / 用户痛点>

## How — 怎么做的
<可以多段;贴关键 code block / 命令行;讲清楚选了哪个方案、放弃了哪个>

\`\`\`<lang>
<verbatim code or shell here>
\`\`\`

## Outcome — 结果
- <merged / 推 PR / 回退 / 阻塞 / 未验证>
- <commit hash 或 PR 链接>
- <next step 如果有>
```

Rules:

- 周报风,流水账;不要博客叙事
- 不要 hallucinate: 没说成的写 "**未完成**" / "**未验证**" / "**阻塞:<原因>**"
- 写 Why 和 Outcome 时,扫一下原 session 末尾几条消息 — user 经常说
  "ok merged" / "didn't work" / "次日继续",这些是关键信号
- 保留 commit hash / 文件路径 / code block / command line verbatim
- Wikilinks: `[[chronicle/<threadId>]]`, `[[<cardSlug>]]`
