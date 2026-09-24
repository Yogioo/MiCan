---
name: 诊断
description: 把这份工作文件夹的运行历史压成一段 JSON，给进化用
entry: run.mjs
outputs:
  选路: json:ok
  text: json:text
route: 选路
routes: true, false
---

读工作文件夹的 `.mican/runs.jsonl`、另存的 `.mican/runs/*.log` 和 `mican.json`，只读不写。
工作文件夹是从 `run.mjs` 往上找到的第一个有 `mican.json` 的目录，跟节点的运行目录无关。
不需要参数。

## 拿到什么

```json
{
  "ok": true,
  "runs": 120,
  "nodes": [
    {"node":"n7","what":"extensions/pi","runs":20,"failed":3,"streak":2,"stuck":0,"avgMs":18342,"routes":{"true":15,"false":2},"avgActs":12.5}
  ],
  "unusedEdges": [{"from":"n7","to":"n9","label":"false"}],
  "repeats": [{"node":"n7","calls":["read docs/规则.md","bash git status"],"runs":16,"of":20}],
  "text": "共 120 次运行（2026-09-01 ~ 2026-09-24）\n……"
}
```

| 名字 | 说明 |
| --- | --- |
| streak | 从最近一次往回数，连着失败了几次 |
| stuck | 跑链时值没对上任何一根执行边的标签、停在这儿的次数 |
| routes | 跑链时走过的执行边标签和次数，兜底边是空串 |
| avgActs | 平均每次多少步动作；只有写了动作行的扩展才有 |
| unusedEdges | 出发节点跑链时记过去向，这根边的标签却一次都没出现 |
| repeats | 同一个节点在至少一半的运行里都连着做的那串动作，最多三串，是改写成脚本的候选 |
| 选路 | 有历史是 true；还没有历史是 false |
| text | 上面这些的人话摘要，一行一件事 |

动作来自扩展写进 stderr 的动作行（见 `extensions/README.md`「输出的契约」），一步记成「工具 + 第一个字符串参数」。
不写动作行的扩展只有 `runs` 到 `routes` 这几项。

## 依赖自负

`run.mjs` 只用 Node 自带的东西。
