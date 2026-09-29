---
name: agent
description: 在运行目录里让 Cursor Agent 干一件事（--yolo，什么都直接跑），把它的回话包成一段 JSON
entry: run.mjs
args: --prompt [[提示词]] --model {{模型}} {{其它}}
defaults:
  模型: 空
  其它: 空
outputs:
  text: json:text
route: json:ok
routes: true, false
---

一份现成的 Cursor Agent CLI 封装，跑的是

    agent -p --yolo --trust --output-format stream-json <提示词>

**`--yolo` 什么命令都直接跑，`--trust` 不问工作区信任**。只在你信得过的运行目录里用。

## 输入和出口

| 名字 | 说明 |
| --- | --- |
| 提示词 | 给 agent 的任务。接文本节点就是那份 md 的路径，短的也可写在框里 |
| 模型 | 框里只填值，如 `sonnet-4-thinking`、`'claude-opus-4-8[effort=high]'`。写「空」用账号默认 |
| 其它 | 整串开关，原样转给 agent，如 `--approve-mcps`、`--mode plan`。写「空」不加 |
| text | agent 最后那段回话，可以有换行 |

提示词的读法跟 pi 那份一样：读得到就当文件，读不到又不像路径（带空格、是网址）就当正文本身。

## 提示词走命令行

`agent -p` 不读 stdin，提示词只能当一个参数传。所以：

- Windows 上**不经** `agent.cmd` / `agent.ps1`（多行的提示词过不了那两层引号），而是直接用
  `%LOCALAPPDATA%\cursor-agent\versions\<最新>\node.exe` 起 `index.js`，挑版本的办法跟 `agent.ps1` 一样。
- 提示词超过 24000 字塞不进命令行：接的是文本节点时，改成让它「打开这份文件照做」（它得先调一次读文件）；
  写在框里的那么长就停下，让你挪到文本节点上。

## 跑起来看得见

`stream-json` 的事件流翻成人话写到 **stderr**（节点正文上的淡色诊断，跑完存成 `.log`）：

```
   0.0s · 起于 D:\work\repo
   1.2s · 会话 2b9d7284-… · Claude Opus 5.5
   5.8s → shell node --test
  12.9s ← shell 12 个用例全过（共 14 行）· 7.1s
  15.0s 测试全过。
  15.1s · agent 退出码 0 · 1 个工具 · 15.1s（工具 7.1s / 模型 8.0s）
```

每调一次工具另写一行动作行（`{"tool":"shell","args":{...}}`，只留原始值、去掉各种 id），留给诊断扩展读。
静下来超过 20 秒会写一行 `… 已经 40s 没有新动静`。开关框里漏了裸词会停在起跑线上，不会被拼进提示词。

## 拿到什么

    {"ok":true,"text":"agent 的回话"}
    {"ok":false,"reason":"一句话说明哪里不对"}

回话本身是一段 JSON 对象时，它的原始值键会抄到顶层（不覆盖 `ok`），可以再声明出口去取。

- agent 非 0 退出、或结果标了 `is_error`（没登录、模型不认识）→ 节点标红。那是**环境失败**。
- 正常退出但一个字没回 → `{"ok":false}`、退出码 0。这是**业务空转**，交给链自己分路。

## 不收插话，不续会话

`agent -p` 是一次性的，跑的时候插不进话。
续会话（`--resume <chatId>`）要的是 agent 自己生成的 id，这份先不接；每次都是新会话。

## 依赖

只用 Node 自带的东西。Cursor Agent CLI 得装好并登录过（`agent status`）。
