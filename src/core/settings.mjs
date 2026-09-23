// 设置分两层，这里是它们唯一的内存副本，也是唯一的口径表（谁有哪些项、默认值、上下限）。
//   跟机器走（machine）：存在用户目录里，不进存档 —— 命令怎么跑、界面手感。换工作文件夹不变。
//   跟画布走（canvas）：进存档 —— 这份流程自己的事，换个文件夹打开就跟着变。
// 用的时候现读 machine.xxx / canvas.xxx，所以设置窗口改完立刻生效，不用把值到处传参。
//
// 加一项配置 = 往表里加一行（设置窗口自己按表画）。值一律过 coerce：存档和配置文件都是外来的，
// 坏了就退回默认，别让一个手改坏的 0 把界面搞塌。

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// kind：text 自由文本 / path 本机路径（带浏览；allowRelative 的可以写相对工作文件夹的路径）/ shell 命令行名（下拉）/ int 整数 / number 小数
// tier：common 直接列出来；advanced 收在「细节」里（默认折叠）；hidden 不在设置窗口里改（由别处负责）
const ADV = { tier: 'advanced' }

export const MACHINE_FIELDS = [
  { group: '命令', key: 'shell', label: '命令行', kind: 'shell', def: '', hint: '命令交给哪个命令行去跑' },
  { group: '命令', key: 'timeout', label: '单个命令最多跑多久', kind: 'int', unit: '秒', def: 7200, min: 1, max: 86400, hint: '超时就掐掉这个节点' },
  { group: '命令', key: 'outputLimitKb', label: '单个命令的输出上限', kind: 'int', unit: 'KB', def: 1024, min: 1, max: 65536, hint: '超过就截断，并在节点上标「输出被截断」' },
  { group: '打开', key: 'openWorkspace', label: '启动时打开的工作文件夹', kind: 'path', def: '', tier: 'hidden', hint: '在「打开」弹窗里勾选，不在这儿改' },
  { group: '界面', key: 'nodeDefaultW', label: '新建节点的宽', kind: 'int', unit: 'px', def: 320, min: 80, max: 2000, hint: '双击空白处新建的文本节点也按这个尺寸' },
  { group: '界面', key: 'nodeDefaultH', label: '新建节点的高', kind: 'int', unit: 'px', def: 200, min: 60, max: 2000 },
  { group: '界面', key: 'nodeMinW', label: '节点缩到最小的宽', kind: 'int', unit: 'px', def: 160, min: 40, max: 2000, hint: '拖右下角缩小时的下限', ...ADV },
  { group: '界面', key: 'nodeMinH', label: '节点缩到最小的高', kind: 'int', unit: 'px', def: 80, min: 30, max: 2000, ...ADV },
  { group: '界面', key: 'zoomMin', label: '最小缩放', kind: 'number', unit: '倍', def: 0.1, min: 0.01, max: 1, hint: '1 就是原始大小', ...ADV },
  { group: '界面', key: 'zoomMax', label: '最大缩放', kind: 'number', unit: '倍', def: 4, min: 1, max: 64, ...ADV },
  { group: '界面', key: 'zoomSensitivity', label: '滚轮灵敏度', kind: 'number', def: 0.0015, min: 0.0001, max: 0.05, hint: '滚一格缩放多少，触控板嫌太灵就调小', ...ADV },
  { group: '界面', key: 'gridStep', label: '点阵间距', kind: 'int', unit: 'px', def: 24, min: 4, max: 200, hint: '背景点阵的基准间距', ...ADV },
  { group: '界面', key: 'dragThreshold', label: '拖动的起步距离', kind: 'int', unit: 'px', def: 4, min: 0, max: 40, hint: '鼠标动过这么多才算拖动，否则算点击', ...ADV },
  { group: '界面', key: 'edgeBow', label: '回程边兜的幅度', kind: 'int', unit: 'px', def: 60, min: 0, max: 400, hint: '两条边反向时向下兜多少，免得叠在一起', ...ADV },
  { group: '界面', key: 'recentMax', label: '最近打开记几条', kind: 'int', unit: '条', def: 8, min: 1, max: 50, hint: '「打开」弹窗里那个列表', ...ADV },
  { group: '界面', key: 'messageMs', label: '提示显示多久', kind: 'int', unit: '毫秒', def: 4000, min: 500, max: 60000, hint: '工具条上那句临时提示', ...ADV },
  { group: '落盘与撤销', key: 'autosaveMs', label: '改动后多久落盘', kind: 'int', unit: '毫秒', def: 500, min: 50, max: 10000, hint: '防抖：连发的改动并成一次写', ...ADV },
  { group: '落盘与撤销', key: 'undoMergeMs', label: '撤销合并的间隔', kind: 'int', unit: '毫秒', def: 500, min: 0, max: 10000, hint: '这段时间内的改动并成一步撤销', ...ADV },
]

// 跟画布走：换个工作文件夹打开，值就跟着换 —— 它是这份流程的一部分，不是这台机器的一部分。
export const CANVAS_FIELDS = [
  {
    group: '运行',
    key: 'cwd',
    label: '运行目录',
    kind: 'path',
    allowRelative: true,
    def: '',
    hint: '整份画布的默认目录：相对工作文件夹的路径（` . ` 就是工作文件夹）或本机绝对路径；某个节点自己设了就覆盖它',
  },
  { group: '运行', key: 'stepLimit', label: '跑链路最多走多少步', kind: 'int', unit: '步', def: 200, min: 1, max: 100000, hint: '环是合法的，这是「跑飞了」的兜底' },
]

// 给界面用：某一层里要摆出来的项（隐藏的不算）
export const shownFields = (fields) => fields.filter((field) => field.tier !== 'hidden')

export const machine = {}
export const canvas = {}
// 面板：跟这份画布走的名字→单行字符串。不进 CANVAS_FIELDS（那张表只收标量）。
export const board = {}

function coerce(field, raw) {
  if (field.kind === 'int' || field.kind === 'number') {
    const value = field.kind === 'int' ? Math.round(Number(raw)) : Number(raw)
    if (!Number.isFinite(value)) return field.def
    return clamp(value, field.min, field.max)
  }
  return typeof raw === 'string' ? raw : field.def
}

// 表里的默认值 → 一份完整对象（缺的补默认，多的丢掉）
const fromDefaults = (fields) => Object.fromEntries(fields.map((field) => [field.key, field.def]))

export function resetMachine() {
  Object.assign(machine, fromDefaults(MACHINE_FIELDS))
  return machine
}

export function resetCanvas() {
  Object.assign(canvas, fromDefaults(CANVAS_FIELDS))
  return canvas
}

export function resetBoard() {
  for (const key of Object.keys(board)) delete board[key]
  return board
}

resetMachine()
resetCanvas()
resetBoard()

// 把外来的那份按表收进来：只认表里的项，逐项校验、超范围夹住，缺的补默认。
export function applyMachine(data) {
  for (const field of MACHINE_FIELDS) machine[field.key] = coerce(field, data?.[field.key])
  // 交叉约束：缩不到比默认还大，缩放上界也不能比下界小
  machine.nodeMinW = Math.min(machine.nodeMinW, machine.nodeDefaultW)
  machine.nodeMinH = Math.min(machine.nodeMinH, machine.nodeDefaultH)
  machine.zoomMax = Math.max(machine.zoomMax, machine.zoomMin)
  return machine
}

export function applyCanvas(data) {
  for (const field of CANVAS_FIELDS) canvas[field.key] = coerce(field, data?.[field.key])
  return canvas
}

// 外来的存档：只认非空单行字符串；重名以后来的为准。
export function boardIn(data) {
  const out = {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (!key || !text || text.includes('\n')) continue
    out[key] = text
  }
  return out
}

export function applyBoard(data) {
  resetBoard()
  Object.assign(board, boardIn(data))
  return board
}

const snapshot = (fields, source) => Object.fromEntries(fields.map((field) => [field.key, source[field.key]]))

// 发给后端的那一份（后端只认 shell / timeout / outputLimitKb / recentMax / openWorkspace，其余原样存着）
export function machinePatch() {
  return snapshot(MACHINE_FIELDS, machine)
}

// 写进存档的那一份
export function canvasPatch() {
  return snapshot(CANVAS_FIELDS, canvas)
}

// 面板写进存档顶层；一格都没有就不带这个键。
export function boardPatch() {
  return Object.keys(board).length ? { ...board } : null
}
