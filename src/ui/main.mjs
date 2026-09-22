// 装配层：持有状态，把状态变更分发给各个界面模块，并定义应用动作。
import {
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  createGraph,
  createNode,
  dataOut,
  findNode,
  removeEdge,
  removeNode,
  setNodeCwd,
  setNodeEntry,
  setNodeText,
} from '../core/graph.mjs'
import { FORMAT_VERSION, deserialize, serialize } from '../core/serialize.mjs'
import { walkDown } from '../core/chain.mjs'
import { applyVars, collectVars } from '../core/vars.mjs'
import { createHistory, push, redo as redoHistory, undo as undoHistory } from '../core/history.mjs'
import { createView, zoomAt } from '../core/view.mjs'
import { mountCanvas } from './canvas.mjs'
import { mountEdges } from './edges.mjs'
import { mountNodes } from './nodes.mjs'
import { mountToolbar } from './toolbar.mjs'
import { askRunDir, askWorkspace } from './workspace-dialog.mjs'

export const state = {
  view: createView(),
  graph: createGraph(),
  selection: null,
  workspace: null, // 工作文件夹的绝对路径，未打开时为 null
  settings: { cwd: '' }, // 全局运行目录，存在用户目录里，不进存档；空串 = 跟随工作文件夹
  running: new Map(), // 运行中的命令节点：id -> 开跑时间。只活在内存里，不进存档
  saving: false, // 有一次落盘还在路上
  message: '',
}

const subscribers = new Set()

// 撤销：只认结构变化，连拖时快速连发的改动合并成一步。
const history = createHistory()
const COALESCE_MS = 500
let lastRecord = 0

function graphSnapshot() {
  const { nodes, edges } = serialize(state)
  return JSON.stringify({ nodes, edges })
}

function viewKey() {
  const { x, y, scale } = state.view
  return `${x},${y},${scale}`
}

export function subscribe(fn) {
  subscribers.add(fn)
  fn(state)
}

function notify() {
  for (const fn of subscribers) fn(state)
}

export function update(mutate) {
  const before = graphSnapshot()
  const wasView = viewKey()
  mutate(state)
  const after = graphSnapshot()
  if (after !== before) {
    const now = Date.now()
    if (now - lastRecord > COALESCE_MS) push(history, before)
    lastRecord = now
  }
  // 视口也算画布状态，所以平移缩放同样要落盘；连拖时防抖会把它们并成一次
  if (after !== before || viewKey() !== wasView) scheduleSave()
  notify()
}

function resetHistory() {
  history.past.length = 0
  history.future.length = 0
  lastRecord = 0
}

// 接口

async function api(route, body) {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`)
  return data
}

let messageTimer = null

function showMessage(text) {
  update((draft) => {
    draft.message = text
  })
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => update((draft) => { draft.message = '' }), 4000)
}

// ---- 落盘 / 另存为 / 打开 ----

// 最近打开过的文件夹，由后端记着（换浏览器、换端口都还在）。
let recent = []

async function loadRecent() {
  try {
    recent = (await api('/api/recent', {})).items ?? []
  } catch {
    recent = []
  }
}

// 全局运行目录也由后端记着，跟这台机器走，不进画布存档。
async function loadSettings() {
  try {
    const data = await api('/api/settings', {})
    update((draft) => { draft.settings = { cwd: typeof data.cwd === 'string' ? data.cwd : '' } })
  } catch {
    // 读不到就当没设
  }
}

// 改动一结束就把内存镜像到工作文件夹（ADR-0003）：没有「保存」这个动作，也没有「未保存」这个状态。
// 防抖只是把连发的改动并成一次；真正保证新鲜的是「跑命令之前先 flush」。

const AUTOSAVE_MS = 500
let scheduled = null // 防抖计时器
let queue = Promise.resolve() // 落盘串成一条链，免得两次写撞在一起
let inFlight = 0

function payload() {
  const docs = state.graph.nodes
    .filter((node) => node.kind === 'text')
    .map((node) => ({ file: node.file, content: node.text }))
  // 缓存文件就是命令节点的值：裸输出写文件，元信息在存档的 results 里
  const cache = state.graph.nodes
    .filter((node) => node.kind === 'command' && node.result)
    .map((node) => ({ id: node.id, content: node.result.output ?? '' }))
  return { canvas: serialize(state), docs, cache }
}

function scheduleSave() {
  if (!state.workspace) return
  clearTimeout(scheduled)
  scheduled = setTimeout(saveNow, AUTOSAVE_MS)
}

// 立刻写一次。命令跑完、链路每一步之后都靠它 —— 缓存文件得马上在盘上。
function saveNow() {
  clearTimeout(scheduled)
  scheduled = null
  if (!state.workspace) return Promise.resolve()
  const body = payload() // 先取一份：排进队列之后状态再变，也不影响这一次写的内容
  inFlight += 1
  state.saving = true
  notify()
  queue = queue.then(() => api('/api/save', body)).then(
    () => settleSave(null),
    (error) => settleSave(error.message),
  )
  return queue
}

function settleSave(failure) {
  inFlight -= 1
  state.saving = inFlight > 0
  if (failure) showMessage(`落盘失败：${failure}`)
  else notify()
}

// 跑命令之前必须把待写的改动写完：命令要读的 md 和缓存文件都得是最新的。
async function flush() {
  if (scheduled) return saveNow()
  return queue
}

// 后端把这次的文件夹排到了历史最前面，前端跟着换一份。
function remember(response) {
  recent = response.recent ?? recent
}

// 打开 / 另存为之后，画布与磁盘就是一致的，所以直接把状态按上去，不排落盘。
// next 就是接下来要用的那份 { graph, view }：打开时是读出来的，另存为时就是手上这份。
function adoptWorkspace(root, next) {
  clearTimeout(scheduled)
  scheduled = null
  state.workspace = root
  state.graph = next.graph
  state.view = next.view
  state.selection = null
  notify()
}

async function saveAs() {
  let initial = ''
  let error = ''
  for (;;) {
    const input = await askWorkspace({ mode: 'create', initial, recent, error })
    if (!input) return
    try {
      const response = await api('/api/workspace', { path: input, mode: 'create' })
      remember(response)
      adoptWorkspace(response.root, { graph: state.graph, view: state.view })
      await saveNow() // 新文件夹里什么都没有，把当前画布整个写过去
      showMessage('已另存为新的工作文件夹')
      return
    } catch (failure) {
      initial = input // 弹窗重新开，错误写在里面，路径不用重打
      error = `另存为失败：${failure.message}`
    }
  }
}

async function openWorkspace() {
  let initial = state.workspace ?? recent[0] ?? ''
  let error = ''
  for (;;) {
    const input = await askWorkspace({ mode: 'open', initial, recent, error })
    if (!input) return
    try {
      const response = await api('/api/workspace', { path: input, mode: 'open' })
      remember(response)
      const restored = response.canvas ? deserialize(response.canvas) : null
      const cache = response.cache ?? {}
      // 元信息在存档里、裸输出在缓存文件里，两份合起来才是一个完整的结果
      if (restored) {
        for (const node of restored.graph.nodes) if (node.result) node.result.output = cache[node.id] ?? ''
      }
      adoptWorkspace(response.root, restored ?? { graph: createGraph(), view: state.view })
      resetHistory()
      showMessage(restored ? '已打开' : '文件夹里没有画布存档，按空白画布打开')
      return
    } catch (failure) {
      initial = input
      error = `打开失败：${failure.message}`
    }
  }
}

// ---- 节点 ----

function createNodeAt(world, kind) {
  const node = createNode({
    kind,
    x: world.x - NODE_DEFAULT_W / 2,
    y: world.y - NODE_DEFAULT_H / 2,
  })
  update((draft) => {
    draft.graph.nodes.push(node)
    draft.selection = { kind: 'node', id: node.id }
  })
}

function deleteSelection() {
  const { selection } = state
  if (!selection) return
  update((draft) => {
    if (selection.kind === 'node') removeNode(draft.graph, selection.id)
    else removeEdge(draft.graph, selection.id)
    draft.selection = null
  })
}

function clearSelection() {
  if (!state.selection) return
  update((draft) => {
    draft.selection = null
  })
}

// ---- 运行命令 ----

let ticking = null

// 秒表：靠定期整帧重绘刷新脚上的秒数，没有命令在跑就停掉。
function startTicking() {
  if (ticking) return
  ticking = setInterval(() => update(() => {}), 500)
}

function stopTicking() {
  if (state.running.size || !ticking) return
  clearInterval(ticking)
  ticking = null
}

// 按 NDJSON 行读 /api/exec 的输出流，边收边回调；返回最后那行终止信息。
async function streamExec(command, cwd, onChunk) {
  const response = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, cwd }),
  })
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? `请求失败（${response.status}）`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let exit = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // JSON 里的换行是转义过的，按真换行切行是安全的
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.type === 'chunk') onChunk(message.data)
      else if (message.type === 'exit') exit = message
    }
  }
  return exit ?? { code: 1, failed: true, output: '连接断了，命令没有回来' }
}

// 命令的运行目录：节点自己设了就用节点的（覆盖全局），没设就跟全局，都没有就是工作文件夹。
function runDirOf(node) {
  return node.cwd || state.settings.cwd || ''
}

// 全局运行目录：所有命令节点的默认值，节点自己设了就不看它。
async function setGlobalRunDir() {
  const current = state.settings.cwd
  const dir = await askRunDir({
    initial: current,
    hint: '所有命令节点的默认运行目录；留空就用工作文件夹',
    quick: [{ label: '工作文件夹', value: '', hint: state.workspace ?? '还没打开工作文件夹' }],
  })
  if (dir === null || dir === current) return
  try {
    const data = await api('/api/settings', { cwd: dir })
    update((draft) => { draft.settings = { cwd: data.cwd ?? '' } })
    showMessage(data.cwd ? `全局运行目录：${data.cwd}` : '全局运行目录：跟随工作文件夹')
  } catch (error) {
    showMessage(`设置失败：${error.message}`)
  }
}

// 单个节点的运行目录：设了就覆盖全局，清空就退回全局；也可以一步点名要工作文件夹。
async function setRunDir(id) {
  const node = findNode(state.graph, id)
  if (!node || node.kind !== 'command') return
  const dir = await askRunDir({
    initial: node.cwd ?? '',
    hint: `相对工作文件夹的路径（“.” 就是工作文件夹），或这台机器上的绝对路径；留空就跟随全局（${state.settings.cwd || '工作文件夹'}）`,
    placeholder: '相对工作文件夹，如 . 或 ./sub；或绝对路径',
    quick: [
      { label: '工作文件夹', value: '.', hint: state.workspace ?? '还没打开工作文件夹' },
      { label: '跟随全局', value: '', hint: state.settings.cwd || '全局没设，就是工作文件夹' },
    ],
  })
  if (dir === null || dir === (node.cwd ?? '')) return
  update((draft) => setNodeCwd(draft.graph, id, dir))
}

// 跑一个命令节点：变量按「此刻」的取值替换，输出边收边显示，跑完写进下游文本节点。
// 成败都返回，让调用方决定怎么说 —— 单跑和跑链用同一套，只差说法。
async function runNode(id) {
  const node = findNode(state.graph, id)
  if (!node || node.kind !== 'command') return { ok: false, reason: '这个节点运行不了' }
  if (!state.workspace) return { ok: false, reason: '先打开一个工作文件夹，命令才有地方跑' }
  if (!node.command.trim()) return { ok: false, reason: '这个命令节点还没有命令' }
  if (state.running.has(id)) return { ok: false, reason: '这个命令还在跑，等它结束' }

  // 变量注入只改这一次要跑的命令，命令节点上的模板不动；取值是「此刻」的，
  // 所以跑链时上游刚写下的缓存文件也能被读到。
  const { vars, errors } = collectVars(state.graph, id, state.workspace)
  const injected = applyVars(node.command, vars)
  const problems = [...new Set([...errors, ...injected.problems])]
  if (problems.length) return { ok: false, reason: `变量没对上：${problems.join('；')}` }
  const command = injected.command

  // 只有数据边把输出带得走；执行边只表达先后，不带数据
  const targets = dataOut(state.graph, id)
    .map((edge) => findNode(state.graph, edge.to))
    .filter((item) => item?.kind === 'text')

  const runDir = runDirOf(node)
  const startedAt = Date.now()
  state.running.set(id, startedAt)
  startTicking()
  update((draft) => {
    const target = findNode(draft.graph, id)
    if (!target) return // 跑起来之前它可能已经被删了
    target.result = null // 上次输出先清掉，节点上只留命令，输出从头攒
    target.live = ''
    target.skipped = false
  })

  // 输出一块块来：先攒进 live，重绘按帧合并，别让快命令把渲染拖住
  let output = ''
  let waitingFrame = false
  const onChunk = (text) => {
    output += text
    const target = findNode(state.graph, id)
    if (target) target.live = output
    if (waitingFrame) return
    waitingFrame = true
    requestAnimationFrame(() => {
      waitingFrame = false
      update(() => {})
    })
  }

  let record
  try {
    record = await streamExec(command, runDir, onChunk)
  } catch (error) {
    record = { code: 1, failed: true, output: error.message }
  }

  state.running.delete(id)
  stopTicking()

  const text = output || record.output || ''
  const result = {
    code: record.code,
    failed: Boolean(record.failed),
    timedOut: Boolean(record.timedOut),
    truncated: Boolean(record.truncated),
    output: text,
    command, // 实际跑的命令（变量已替换），留着让节点上能回看
    at: Date.now(),
    elapsed: Date.now() - startedAt, // 跑完也留着，脚上照样看得到跑了多久
  }
  update((draft) => {
    const target = findNode(draft.graph, id)
    // 跑的时候节点可能已经被删了或被撤销掉了
    if (target) {
      target.result = result // 裸输出进缓存文件、元信息进存档
      target.live = ''
    }
    if (!result.failed) for (const item of targets) setNodeText(draft.graph, item.id, text)
  })

  return { ok: true, result, targets: targets.length }
}

async function runCommand(id) {
  await flush()
  const outcome = await runNode(id)
  if (!outcome.ok) return showMessage(outcome.reason)
  if (outcome.result.failed) showMessage(`退出码 ${outcome.result.code}，没有覆写下游文本节点`)
  else if (outcome.targets === 0) showMessage('没有下游文本节点，输出只显示在节点上')
  else showMessage(`输出已灌给 ${outcome.targets} 个下游文本节点`)
  await saveNow() // 跑完立刻落盘：缓存文件得马上在盘上，下游和断电都等着它
}

// 跑链路：从入口顺着执行边一路跑下去，一个失败就停，后面那些标成没运行。
async function runChain(entryId) {
  const ids = walkDown(state.graph, entryId)
  if (!ids.length) return
  await flush()

  for (let index = 0; index < ids.length; index += 1) {
    const outcome = await runNode(ids[index])
    const behind = ids.slice(index + 1)
    if (!outcome.ok) {
      markSkipped(behind)
      return showMessage(`第 ${index + 1} 个没跑起来：${outcome.reason}${behind.length ? `；后面 ${behind.length} 个没跑` : ''}`)
    }
    // 跑一个就落一次盘：下一个节点要读它的缓存文件，断在这儿也不白跑
    await saveNow()
    if (outcome.result.failed) {
      markSkipped(behind)
      return showMessage(`第 ${index + 1} 个退出码 ${outcome.result.code}，链停在这儿${behind.length ? `；后面 ${behind.length} 个没跑` : ''}`)
    }
  }
  showMessage(`链路跑完：${ids.length} 个命令节点`)
}

// 没跑到的那些在节点上留一句话，不然分不清「没跑」和「跑出来是空的」。
// 这不是画布状态（不进存档），所以不走历史也不排落盘。
function markSkipped(ids) {
  if (!ids.length) return
  update((draft) => {
    for (const id of ids) {
      const node = findNode(draft.graph, id)
      if (node) node.skipped = true
    }
  })
}

// ---- 视图 / 存档 ----

function resetZoom() {
  const viewport = document.getElementById('viewport')
  update((draft) => {
    draft.view = zoomAt(draft.view, viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / draft.view.scale)
  })
}

function applyGraph(snapshot) {
  const { nodes, edges } = JSON.parse(snapshot)
  // 运行结果不是被编辑的结构，撤销不该顺手把它扫掉（那会连带删掉磁盘上的缓存文件），按 id 接回来
  const kept = new Map(state.graph.nodes.map((node) => [node.id, node.result]))
  const restored = deserialize({ version: FORMAT_VERSION, nodes, edges }).graph
  for (const node of restored.nodes) {
    if (node.kind === 'command' && kept.get(node.id)) node.result = kept.get(node.id)
  }
  state.graph = restored
  state.selection = null
  lastRecord = 0 // 下一次改动重新开一步
  scheduleSave()
  notify()
}

function undo() {
  const snapshot = undoHistory(history, graphSnapshot())
  if (snapshot !== null) applyGraph(snapshot)
}

function redo() {
  const snapshot = redoHistory(history, graphSnapshot())
  if (snapshot !== null) applyGraph(snapshot)
}

// ---- 键盘 ----

window.addEventListener('keydown', (event) => {
  if (document.activeElement !== document.body) return // 编辑态不抢键
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelection()
  }
})

// 不拦关闭：改动一结束就落盘了，没有「未保存」这个状态可以警告（ADR-0003）

// ---- 装配 ----

mountCanvas({
  getView: () => state.view,
  setView: (view) => update((draft) => { draft.view = view }),
  subscribe,
  onBackgroundPress: clearSelection,
  onBackgroundDblClick: (world) => createNodeAt(world, 'text'),
  onResetZoom: resetZoom,
})

const edges = mountEdges({ getState: () => state, update, onError: showMessage })
const nodes = mountNodes({
  getState: () => state,
  update,
  onConnectStart: edges.startConnection,
  onRunCommand: runCommand,
  onRunChain: runChain,
  // 菜单里只在「没有执行入边」的节点上给这一项，所以 setNodeEntry 不会拒绝
  onToggleEntry: (id) => update((draft) => setNodeEntry(draft.graph, id, !findNode(draft.graph, id)?.entry)),
  onNewCommandNode: (world) => createNodeAt(world, 'command'),
  onSetRunDir: setRunDir,
})
const toolbar = mountToolbar({ getState: () => state, actions: { saveAs, openWorkspace, resetZoom, setGlobalRunDir } })
loadRecent()
loadSettings()

const hint = document.getElementById('hint')

subscribe((next) => {
  hint.classList.toggle('hidden', next.graph.nodes.length > 0)
})
subscribe(edges.render)
subscribe(nodes.render)
subscribe(toolbar.render)
