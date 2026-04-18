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
