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

## What — what was done
- <bullet by time or task granularity; preserve commit hashes / file paths / command lines>
- ...

## Why — why it was needed
- <triggering motivation / bug scenario / upstream decision / user pain point>

## How — how it was done
<can span multiple paragraphs; paste the key code blocks / command lines;
explain which approach was chosen and which was rejected>

\`\`\`<lang>
<verbatim code or shell here>
\`\`\`

## Outcome — result
- <merged / PR pushed / rolled back / blocked / unverified>
- <commit hash or PR link>
- <next step, if any>
```

Rules:

- Weekly-report voice, factual log style — NOT blog narrative.
- Do NOT hallucinate. If something didn't land, write
  "**unfinished**" / "**unverified**" / "**blocked: <reason>**".
- When writing Why and Outcome, scan the last few messages of the
  source session — users often drop key signals like "ok merged",
  "didn't work", "continuing tomorrow" right at the end.
- Preserve commit hashes / file paths / code blocks / command lines verbatim.
- Use the same language as the source session for the body content
  (Chinese sessions → Chinese chronicle; English sessions → English).
  The frontmatter + section headings stay in this template's language
  for consistency.
- Wikilinks: `[[chronicle/<threadId>]]`, `[[<cardSlug>]]`.
