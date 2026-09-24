# 缓存目录可以整个忽略

Status: accepted · 已实现

`.mican/` 叫缓存目录，用户自然会把它整个忽略掉。但面板的值（ADR-0016）、进化配置和进化记录（ADR-0024）也放在里面：
忽略之后换台机器，面板值、自动进化的条件、撤销要用的记录都没了。

决定：

- **`.mican/` 只放运行产生的东西**：缓存文件、`results.json`、`runs.jsonl` 和 `runs/`、每次进化的提示词和过程（`.mican/evolve/`）。
- **用户数据搬到顶层**：面板的值 `board/<名字>.md`；进化配置 `evolve/config.json`、进化记录 `evolve/history.jsonl`。
  `evolve/` 仍不在 pi 能改的三层里，进化的快照、回滚、commit 也不圈它。
- **旧工作文件夹打开时就地搬**：`.mican/board`、`.mican/evolve/config.json`、`.mican/evolve/history.jsonl` 在、顶层对应的不在，就挪过去。
- **推荐的忽略规则只有 `.mican/`**：写进 ITERATE.md；工作文件夹模板里带一份 `.gitignore`，新建时跟 Agent 文档一起落下，旧的可从设置导入。

## Consequences

1. 进化记录跟着仓库走，换台机器面板上也有记录、能撤销；记录里的过程 `.log` 在缓存目录，换机器就看不到了。
2. 面板值会被链写回，提交时会看到它们在变，这是用户数据本来的样子。
