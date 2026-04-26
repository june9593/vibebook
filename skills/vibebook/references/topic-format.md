# Topic page format

```markdown
---
title: <human-readable subsystem name>
project: <project-slug>
topic: <topic-slug>
created: YYYY-MM-DD       # 第一次写时
updated: YYYY-MM-DD       # 每次 update 时改
contributingThreads: [<threadId>, ...]
relatedCards: [cards/<slug>.md, ...]
---

# <title>

## 这个 topic 是什么
<一段总览;子系统目的、所在代码 root>

## 关键概念
<核心概念、文件、抽象。例: ImmersiveModeControllerMac 的责任、与 Chromium
upstream 的关系、关键 enum / state machine>

## 历史问题与修法（按时间倒序）
- 2026-04-22 [[chronicle/fix-fullscreen-bookmark-bar]] — 修了切换 app 时打点
  漏调,通过监听 widget activation 判断
- 2026-03-15 [[chronicle/immersive-mode-rewrite]] — V1→V2 重写,引入
  IsImmersiveModeEnabled 状态机

## 当前已知坑
- [[cards/gotcha-immersive-mode-controller-mac-uaf]] — popup destroy 顺序
- [[cards/pattern-msa-aad-pref-helper]] — MSA / AAD pref 适配方法

## 相关
- [[chronicle/...]]
- [[cards/...]]
```

Rules:

- Topic = mid-grain subsystem (`native-ui-fullscreen`, `bookmark-bar`,
  `mojo-ipc`, `crash-debugging-macos`). Not a single bug; not a whole project.
- A thread can touch 0, 1, or many topics.
- **Update preserves history**: when rewriting, every old historical fact
  (旧 thread 记录、旧"已知坑") MUST stay in the new page. The publish step
  backs the old page up to `<slug>.md.bak` so you can recover if you
  accidentally drop something.
- Wikilinks: `[[chronicle/<threadId>]]`, `[[<cardSlug>]]`.
