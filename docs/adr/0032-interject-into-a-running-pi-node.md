# 插话：人能在 pi 正跑的时候插一句，pi 节点改走 RPC

Status: accepted · 已实现

pi 节点跑起来之后是个黑盒：它自己绕圈子（同一个测试改三遍、在两个方案之间来回），
而人**看得见**（诊断行铺在节点正文上）却**说不上话** —— 唯一的办法是掐掉整个进程重来，
或者等它跑完再拿同一份会话追问（那是「商量」ADR-0028 那条路，改的却是别人的盘）。
等一分钟它就多烧一分钟，而人想说的常常只有一句：「别改了，直接回话」。

## 决定

### 插话是一个动作，两种发法

人往一枚**正在跑**的节点里塞一句话。**只有正在跑的那一步收得到** —— 这一步跑完（pi 退出）
或链已经走到下一个节点，就只剩看。这句话不改链怎么走，也不落进节点的值。

两种发法各对应 pi 的一个队列：

- **中断并发送**：先停它手上那一步，再把这句当新指令交过去。
- **添加并发送**：不打断，等它手上那一轮做完、下一次模型调用之前收到。

`follow_up`（等整趟彻底做完再做）**不做**：那个需求今天的「会话」重跑已经能做，
多一个按钮只是多一个歧义。

### 底座：pi 节点从 `--mode json` 换成 `--mode rpc`

`--mode json` 是一次性的：stdin 只喂第一条提示词，喂完就走到头。**「不中断地插一句话」在它里面不存在。**
`--mode rpc` 是长驻的：stdin 收 JSONL 命令，其中的 `steer` 正好是「添加并发送」，
`clear_queue` + `abort` + `prompt` 正好是「中断并发送」。

换底座之前先验过代价（同一条提示词两种模式各跑一遍）：

| | `--mode json`（原来） | `--mode rpc`（现在） |
| --- | --- | --- |
| 事件族 | `session` `agent_start` `turn_start` `message_start/end` `message_update` `tool_execution_start/update/end` `turn_end` `agent_end` `agent_settled` | 同一批；**少 `session` 一条**，多 `response` 与 `extension_ui_request` |
| `message_update` 内层 | `thinking_*` `toolcall_*` `text_*` | 一模一样 |
| 工作目录 | 节点给的运行目录 | 一样（实测 `pwd` 就是 spawn 时那个目录） |
| stderr | pi 一个字节不写，全是 `run.mjs` 自己写 | 一样 |
| 怎么收尾 | 吐完事件自己退，靠进程 close | **不退**，要等 `agent_settled` 之后自己关 stdin |

所以节点上给人看的东西一个字不变：正文那套「轮 / 动作 / 收成 / 想了想 / 没有新动静」、
值那段 JSON、看诊断的 `.log` 边车、下游的提取节点与 `[[ ]]` 全都照旧。差异只有三条小账：

1. **「· 起于 <cwd>」那行**原来靠 `session` 事件，改用 `process.cwd()`。
2. **多两类记录**（`response` 与 `extension_ui_request`）—— `trace()` 的 switch 没有 default，
   天然忽略，漏不进正文。真正要管的是 **dialog 类**（`select` / `confirm` / `input` / `editor`）：
   它会阻塞等人答，而这儿没有人在答。脚本一律回「取消」，并往诊断里留一行。
3. **收尾判据**从「进程 close」改成「`agent_settled` 到了就关 stdin」。

### 这条反向通道怎么走

`--mode json` 时代 `stdin` 是死的（`exec.mjs` 一 spawn 就 `end()`）。现在：

```
浏览器 → POST /api/say → runner → exec 的子进程 stdin → node run.mjs 的 stdin → pi 的 stdin
```

`exec.mjs` 只负责「留着 stdin、能往里写一行」，它不认识插话；
**中间那段协议归扩展自己**：一行一段 JSON，`{"say":"…","interrupt":true|false}`。
`run.mjs` 把它翻成 `steer`，或 `clear_queue` → `abort` → `prompt`。
stdin 一关（今天就是这样）就等于「这枚节点不收话」—— 老行为原样成立。

留 stdin 开着的**只有声明了这件事的节点**（pi 那份 `EXTENSION.md` 里一行），别的命令照旧 `end()`：
不 `end()` 的话，读 stdin 的命令会一直挂到超时。

### 谁来收、收在哪儿

- **接口认 nodeId**：前端手上 `state.running` 就是节点 id 集合。后端找那条 `current.nodeId` 是它的活跃运行，
  顺带把「此刻正在跑的是不是它」验掉了。**占用**（ADR-0027）已经保证同时只有一条链碰得到这枚节点。
- **框在那枚节点的正文底下**，只在跑的时候活。发出去的进运行事件流（页面重连看得到）
  + 运行日志一行（`t: "say"`，ADR-0031 同一份 jsonl，全文就在行上 —— 它是一句人话，
  跟 `end` 的 `message`、`skip` 的 `note` 一样，不是值，不进附件）。
  **不进节点的值、不进缓存文件**：插话是过程，不是这一步的产物。
  没送达的那句（进程已经收了尾）报回前端、退回输入框，不留痕。
- **草稿不落盘、不进撤销栈** —— 跟「选中」一个待遇，界面上的临时状态。
- **插话给这一步的超时续一次命**：超时是防卡死，不是防人聊得久。这是 `exec.mjs` 除 stdin 外唯一要动的地方。

## Considered Options

- **绕开 RPC：掐掉这一步，拿同一把会话钥匙重跑，把这句当这一轮的消息**（「商量」那条路）。
  它省下 `run.mjs` 与文档那一大块，但 **「添加并发送」彻底做不了** —— 不中断只在 RPC 里有；
  而且每次插话都要重启一次 pi（重扫上下文、重连 MCP），换来的是「对话不断、手上跑到一半的活丢掉」，
  恰好是插话最想避免的那件事。MiCan 这一头（接口、节点上的框、留痕）一行也省不掉。
- **只做「中断并发送」**：上面那条的简化版，代价一样，还少一半能力。
- **加第三个按钮 `follow_up`**：多一个歧义，换不来新能力。
- **把插话做成一种新节点（用户输入节点）**：那是「节点主动叫人」（TODO 里另一条），方向相反；
  插话要的是打断正在跑的那一个，不是让链停下来等人。
- **让任何命令节点都能收话**：读 stdin 的命令会挂到超时，而且没有扩展接得住这句。
  先只给 pi 这一份。

## Consequences

1. `server/extensions.mjs`：清单认一行 `talk`，`commandOf` 一并交回去。
2. `server/exec.mjs`：`startCommand` 收 `talk` —— 留 stdin、返回 `say()` 与 `touch()`（重置超时）。
3. `server/runner.mjs`：按扩展声明决定 `talk`；`say(id, text, interrupt)` 找活跃运行并校验；
   插话写一行 `t: "say"` 日志并往事件流发一个 `say`；插话时 `touch()` 那一步的超时。
4. `server/api.mjs`：`POST /api/say`。
5. `builtin/extensions/pi/run.mjs`：改走 `--mode rpc`；读自己 stdin 的那份 JSON 协议；
   `agent_settled` 收尾；dialog 一律回取消。**stdout 的契约一个字不变**（还是一段 JSON）。
6. `builtin/extensions/pi/EXTENSION.md`：这几段要重写 ——「跑起来看得见」「退出码跟着 pi 走」「留会话 / 会话」，另加一节「插话」。
7. `src/ui/nodes.mjs` + `src/ui/main.mjs`：节点正文底下那个框与两个按钮；`src/ui/run-log-window.mjs` 认第五种行。
8. 已知风险：**「中断并发送」是硬停** —— 跑到一半的工具调用会被丢下（正在写的大文件就是写了一半）。
   按钮文案要让人有心理准备，这是选了「最快停下」的代价。
