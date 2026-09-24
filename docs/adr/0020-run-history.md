# 运行历史

Status: accepted · 已实现

以前只留「最近一次」：`<节点id>.out` / `.log`、存档里的 `results`。看不出「这根边从来没走过」「这个节点连败 8 次」，
自进化（[ai-evolution.md](../ai-evolution.md)）没有信号。

决定：运行器每跑完一个会跑的节点，往 `.mican/runs.jsonl` 追加一行：

```json
{"at":1730000000000,"node":"n7","chain":"n1","by":"timer","route":"有单","code":0,"failed":false,"ms":18342,"log":"1730000000000-n7.log"}
```

- `at`：跑完的时刻。`node`：这一步的节点。`chain`：这次运行从哪个节点发起（跑链是入口或定时器，单独跑是节点自己）。
  `by`：`manual` / `timer`。`code` / `failed` / `ms`：同节点上的结果。
- `route`：跑链时这一步走的那根执行边的标签（兜底边是空串）；没往下走就没有这一列。
- `log`：这一步有 stderr 就另存成 `.mican/runs/<at>-<节点id>.log`，这里记文件名。每个节点只留最近 `runLogKeep` 份（机器设置，默认 20）。

值不进历史（缓存文件里有）。`runs.jsonl` 只追加、不轮转，要清用户自己删。验不过、没跑起来的那一步不记。

## Considered Options

- **历史进存档**：每跑一次存档就变，自进化的 commit 会夹着运行噪声。
- **`.out` 也按次另存**：诊断用不上，体积翻倍。
- **`.log` 不另存、只记元信息**：看不见节点里面 agent 做了什么，找不出「能收进脚本的那串动作」。

## Consequences

1. `routeFrom` 多回一个 `label`。
2. 写历史出错不影响这次运行；`.log` 存不下来时这一行照记，只是不带 `log`。
3. `.mican/` 的清理只扫顶层的 `.out` / `.log`，`runs.jsonl` 和 `runs/` 不受影响。
