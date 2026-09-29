---
name: codex
description: 在运行目录里让 codex 干一件事（不问、不进沙箱），把它的回话包成一段 JSON
entry: run.mjs
args: --prompt [[提示词]] --留会话 {{留会话}} --model {{模型}} {{其它}}
defaults:
  留会话: false
  模型: 空
  其它: 空
outputs:
  text: json:text
route: json:ok
routes: true, false
---

一份现成的 codex 封装，跑的是

    codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -

**不问人、不进沙箱**：它想跑什么命令、改哪个文件都直接动手。只在你信得过的运行目录里用。

## 输入和出口

| 名字 | 说明 |
| --- | --- |
| 提示词 | 给 codex 的任务。接文本节点就是那份 md 的路径，短的也可写在框里。从 stdin 递过去，多长都行 |
| 留会话 | 只认 true / false。false（默认）补 `--ephemeral`，不落盘；true 留下，过后能 `codex resume` 翻回来看 |
| 模型 | 框里只填值，如 `gpt-5.5`。写「空」用 codex 自己的默认 |
| 其它 | 整串开关，原样转给 `codex exec`，如 `-c model_reasoning_effort=high`。写「空」不加 |
| text | codex 最后那段回话，可以有换行 |

提示词的读法跟 pi 那份一样：读得到就当文件，读不到又不像路径（带空格、是网址）就当正文本身。

## 跑起来看得见

`--json` 的事件流翻成人话写到 **stderr**（节点正文上的淡色诊断，跑完存成 `.log`）：

```
   0.0s · 起于 D:\work\repo
   0.4s · 会话 01a0ec5b-…
   0.4s ─ 第 1 轮
   6.1s → shell pwsh -Command 'node --test'
  13.0s ← shell 12 个用例全过（共 14 行）· 6.9s
  15.2s 测试全过。
  15.3s · codex 退出码 0 · 1 个工具 · 15.3s（工具 6.9s / 模型 8.4s）
```

每调一次工具另写一行动作行（`{"tool":"shell","args":{...}}`），留给诊断扩展读。
静下来超过 20 秒会写一行 `… 已经 40s 没有新动静`。开关框里漏了裸词会停在起跑线上，不会让 codex 把它当成提示词。

## 拿到什么

    {"ok":true,"text":"codex 的回话"}
    {"ok":false,"reason":"一句话说明哪里不对"}

回话本身是一段 JSON 对象时，它的原始值键会抄到顶层（不覆盖 `ok`），可以再声明出口去取。

- codex 非 0 退出、或这一轮失败（认证没了、模型不认识）→ 节点标红。那是**环境失败**。
- 正常退出但一个字没回 → `{"ok":false}`、退出码 0。这是**业务空转**，交给链自己分路。

## 不收插话，不续会话

`codex exec` 是一次性的，stdin 喂完提示词就关，跑的时候插不进话。
续会话（`codex exec resume <id>`）要的是 codex 自己生成的 id，这份先不接。

## 依赖

只用 Node 自带的东西。codex 本身得装好并登录过（`codex login status`）。
Windows 上优先直接用 node 起 `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`，找不到才走 `codex.cmd`。
