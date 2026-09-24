# 动作行混在 stderr 里

Status: accepted · 已实现

诊断扩展（[ai-evolution.md](../ai-evolution.md)）要从运行历史里找「多次运行里 agent 都在重复的那串工具调用」。
stderr 已经按次另存（[ADR-0020](0020-run-history.md)），但里面是给人看的话，各家扩展写法不一样，没法统一解析。

决定：agent 类扩展每调一次工具，往 stderr 单独写一行 JSON，整行就是它：

```json
{"tool":"read","args":{"path":"src/app.mjs"}}
```

- 人话照写，动作行跟它混在同一条流里。画布显示诊断时藏掉「整行是一段带字符串 `tool` 的 JSON 对象」的行。
- 诊断扩展从 `.mican/runs/*.log` 里读这些行，一步记成「工具 + 第一个字符串参数」。
- 长字符串参数由扩展自己截短（pi 截到 200 字），免得 `.log` 被 write 的整份内容撑大。

## Considered Options

- **stderr 只写 JSON，画布负责渲染成人话**：翻译逻辑要从每家扩展挪进画布，画布就得认识各家 agent。
- **按人话前缀解析（`→` / `←`）**：人话的写法一改诊断就坏，也逼着每家扩展照抄 pi 的格式。
- **另开一个文件给动作行**（runner 用环境变量给路径）：runner 要多存一份、多记一列，而 `.log` 本来就按次存着。

## Consequences

1. 画布正文不显示动作行；`.mican/<节点id>.log` 和另存的 `.log` 里仍有它们。
2. 不写动作行的扩展照常能跑，诊断里只是没有动作那两项（`avgActs`、`repeats`）。
