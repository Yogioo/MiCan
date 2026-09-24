// 存档格式：与工作文件夹里的 mican.json 共用的唯一结构。
// 7 版起一份存档拆成四处（ADR-0023）：逻辑 mican.json、布局 mican.layout.json、正文 docs/ 的 md、运行结果 .mican/results.json。
// 前端内存里照旧是一张图，拆只发生在落盘和打开。
import { CMD_BAR_H } from './geometry.mjs'
import { baseName, newId, runnable, uniqueName } from './graph.mjs'
import { DEFAULT_SCHEDULE } from './schedule.mjs'
import { boardIn, boardPatch, canvasPatch, machine } from './settings.mjs'
import { clampScale } from './view.mjs'

export const FORMAT_VERSION = 7
// 2 是引入边的两族之前，3 是提取节点之前，4 是画布设置之前，5 是入口节点之前，6 是拆存档之前
const READABLE = new Set([2, 3, 4, 5, 6, FORMAT_VERSION])
// 布局里没有的节点，摆在上游右边隔这么远
const PLACE_GAP = 60

// 落盘的两份：canvas 是逻辑（mican.json），layout 是布局（mican.layout.json）。正文走 docs，结果只由后端写。
export function serialize(state) {
  return pack(state.graph, state.view, canvasPatch(), boardPatch())
}

function pack(graph, view, settings, board) {
  return {
    canvas: {
      version: FORMAT_VERSION,
      settings, // 跟这份画布走的设置（换工作文件夹打开就跟着变）
      ...(board ? { board } : {}), // 面板：空表不写进存档
      nodes: graph.nodes.map(logicOf),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        label: edge.label ?? '',
        ...(edge.fromPort ? { fromPort: edge.fromPort } : {}),
      })),
    },
    layout: {
      view: { x: view.x, y: view.y, scale: view.scale },
      nodes: Object.fromEntries(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y, w: node.w, h: node.h }])),
    },
  }
}

function logicOf(node) {
  const head = { id: node.id, name: node.name, kind: node.kind }
  if (node.kind === 'command') {
    return {
      ...head,
      command: node.command,
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(node.extension ? { extension: node.extension } : {}),
      ...constsPatch(node),
    }
  }
  if (node.kind === 'extract') return { ...head, pick: node.pick ?? '' }
  if (node.kind === 'get' || node.kind === 'set') return { ...head, slot: node.slot ?? '' }
  if (node.kind === 'timer') return { ...head, schedule: node.schedule ?? '' }
  if (node.kind === 'entry') return head
  return { ...head, file: node.file }
}

// 文本节点的正文：id -> 正文。撤销快照带着它，落盘时它就是 docs 那几份 md。
export const textsOf = (graph) =>
  Object.fromEntries(graph.nodes.filter((node) => node.kind === 'text').map((node) => [node.id, node.text ?? '']))

// 6 版及以前的一份存档拆成四处（后端打开旧存档时就地写回）。
export function split(data) {
  const { graph, view, settings, board } = deserialize({ canvas: data })
  const results = data.results && typeof data.results === 'object' ? data.results : {}
  return { ...pack(graph, view, settings ?? {}, Object.keys(board).length ? board : null), results, texts: textsOf(graph) }
}

// 定时器的一笔触发记录：什么时候响的、这一下是跑了还是跳过了。
export function triggerMeta(node) {
  const { at, skipped, note } = node.result
  return { at, skipped: Boolean(skipped), ...(note ? { note } : {}) }
}

// 一个会跑的节点存进 results 的那点元信息。裸输出不进来（它在缓存文件里）。
export function resultMeta(node) {
  const { code, failed, timedOut, truncated, at, elapsed, command } = node.result
  // 提取节点不 spawn 进程，没有退出码可报，只记时间
  return node.kind === 'command'
    ? { code, failed: Boolean(failed), timedOut: Boolean(timedOut), truncated: Boolean(truncated), at, elapsed, command }
    : { at, elapsed }
}

// 端口上填的常量：非空的字符串才写进存档，一个都没有就不写这个键。
const constsPatch = (node) => {
  const out = constsIn(node.consts)
  return Object.keys(out).length ? { consts: out } : {}
}

// 外来的存档（手改、旧版本、写坏了）：常量只认非空字符串，其余一律丢掉。
function constsIn(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string' && value) out[key] = value
  return out
}

const objectOr = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

// 校验并还原：不认识的结构直接报错，能救的地方（尺寸过小、悬空的边、缺名字、缺位置）就地修掉。
// 入参是拆开的那几份；6 版及以前只有 canvas 一份，位置、正文、结果、视图都从它身上取。
// center：布局里没有、又没有上游的节点摆在哪（世界坐标）。
export function deserialize({ canvas: data, layout, texts, results } = {}, { center = { x: 0, y: 0 } } = {}) {
  if (!data || typeof data !== 'object') throw new Error('不是有效的 JSON 对象')
  if (!READABLE.has(data.version)) throw new Error(`不支持的版本：${data.version}`)
  if (!Array.isArray(data.nodes)) throw new Error('nodes 不是数组')
  if (!Array.isArray(data.edges)) throw new Error('edges 不是数组')

  const legacy = data.version < FORMAT_VERSION
  const boxes = legacy ? Object.fromEntries(data.nodes.map((node) => [node?.id, node])) : objectOr(layout?.nodes)
  const bodies = legacy ? Object.fromEntries(data.nodes.map((node) => [node?.id, node?.text])) : objectOr(texts)
  const metas = objectOr(legacy ? data.results : results)
  const view = objectOr(legacy ? data.view : layout?.view)

  const nodes = data.nodes.map((node, index) => {
    if (!node || typeof node.id !== 'string') throw new Error(`第 ${index + 1} 个节点缺少 id`)
    const box = objectOr(boxes[node.id])
    // 位置不全就留 NaN，等边都还原了再按上游摆
    const at = Number.isFinite(box.x) && Number.isFinite(box.y) ? { x: box.x, y: box.y } : { x: NaN, y: NaN }
    const w = Math.max(machine.nodeMinW, Number.isFinite(box.w) ? box.w : machine.nodeDefaultW)
    const h = Math.max(machine.nodeMinH, Number.isFinite(box.h) ? box.h : machine.nodeDefaultH)
    const head = { id: node.id, name: typeof node.name === 'string' ? node.name.trim() : '', ...at, w, h }
    if (node.kind === 'command') {
      return {
        ...head,
        kind: 'command',
        command: typeof node.command === 'string' ? node.command : '',
        // 端口上填的常量（见 graph.mjs 的 setNodeConst）
        consts: constsIn(node.consts),
        cwd: typeof node.cwd === 'string' ? node.cwd : '',
        // 引用扩展的节点：存的是扩展目录（相对工作文件夹），命令在跑的时候现拼（ADR-0014）
        extension: typeof node.extension === 'string' ? node.extension : '',
      }
    }
    if (node.kind === 'extract') return { ...head, kind: 'extract', pick: typeof node.pick === 'string' ? node.pick : '' }
    if (node.kind === 'get') return { ...head, kind: 'get', h: CMD_BAR_H, slot: typeof node.slot === 'string' ? node.slot : '' }
    if (node.kind === 'set') return { ...head, kind: 'set', slot: typeof node.slot === 'string' ? node.slot : '' }
    if (node.kind === 'entry') return { ...head, kind: 'entry' }
    if (node.kind === 'timer') {
      return { ...head, kind: 'timer', schedule: typeof node.schedule === 'string' && node.schedule.trim() ? node.schedule : DEFAULT_SCHEDULE }
    }
    const file = typeof node.file === 'string' ? node.file : ''
    if (!file || file.startsWith('/') || file.split(/[\\/]/).includes('..')) {
      throw new Error(`节点 ${node.id} 的文件路径不合法：${file}`)
    }
    return { ...head, kind: 'text', file, text: typeof bodies[node.id] === 'string' ? bodies[node.id] : '' }
  })

  // 5 版及以前，「入口」是命令节点上的一个布尔值；6 版起它是一枚独立的节点。
  // 载入时把旧标记就地换成一根入口节点 + 一根执行边，画布照样跑，不用用户重连。
  const migrated = []
  if (data.version < 6) {
    for (const [index, node] of nodes.entries()) {
      if (node.kind !== 'command' || data.nodes[index]?.entry !== true) continue
      const entry = { id: newId('n'), name: '', kind: 'entry', x: node.x, y: node.y - 90, w: machine.nodeDefaultW, h: machine.nodeDefaultH }
      nodes.push(entry)
      migrated.push({ id: newId('e'), from: entry.id, to: node.id, kind: 'exec', label: '' })
    }
  }

  const ids = new Set(nodes.map((node) => node.id))
  const kindOf = new Map(nodes.map((node) => [node.id, node.kind]))
  const isRunnable = (id) => {
    const kind = kindOf.get(id)
    return kind === 'command' || kind === 'extract' || kind === 'set'
  }
  // 触发节点是起点：进来一根执行边、或跟它传数据，都是没意义的状态，载入时直接丢掉。
  // 获取像文本：只出数据，不接数据，也不走执行边。
  const edgeOk = (kind, from, to) => {
    const a = kindOf.get(from)
    const b = kindOf.get(to)
    if (kind === 'data') {
      if (a === 'entry' || a === 'timer' || b === 'entry' || b === 'timer') return false
      return b !== 'get'
    }
    if (a === 'entry' || a === 'timer') return isRunnable(to)
    return isRunnable(from) && isRunnable(to)
  }

  const source = [...data.edges, ...migrated]
  const edges = []
  for (const edge of source) {
    if (!edge || typeof edge.id !== 'string') continue
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue // 悬空的边丢掉
    const kind = edge.kind === 'exec' ? 'exec' : 'data' // 2 版全是文本节点喂命令，都是数据边
    // 最早的 6 版把定时器接在入口前面（「定时器 → 入口 → 命令」）。入口与定时器本来就是并列的
    // 两种触发，定时器不该再挂一层：把它的出边挪到那个入口指着的第一个会跑的节点上。
    // 入口节点留着（它还是「人手跑这条链」的入口），所以这条链会多一根并排进来的边。
    let to = edge.to
    if (kind === 'exec' && kindOf.get(edge.from) === 'timer' && kindOf.get(to) === 'entry') {
      const head = source.find((item) => item?.kind === 'exec' && item.from === to)?.to
      if (isRunnable(head)) to = head
    }
    if (!edgeOk(kind, edge.from, to)) continue
    edges.push({
      id: edge.id,
      from: edge.from,
      to,
      kind,
      label: typeof edge.label === 'string' ? edge.label : '',
      ...(typeof edge.fromPort === 'string' && edge.fromPort ? { fromPort: edge.fromPort } : {}),
    })
  }

  const placed = place(nodes, edges, center)

  // 名字画布内唯一：缺的、撞了的（后来的那个）按新建的规矩补一个
  const seen = new Set()
  for (const node of nodes) {
    if (node.name && !seen.has(node.name)) seen.add(node.name)
    else node.name = ''
  }
  for (const node of nodes) if (!node.name) node.name = uniqueName(nodes, baseName(node))

  // 元信息先挂上，裸输出等缓存文件那一份读回来再填（触发记录没有裸输出）。
  for (const node of nodes) {
    if (!metas[node.id]) continue
    if (runnable(node)) node.result = { ...metas[node.id], output: '' }
    else if (node.kind === 'timer') node.result = { ...metas[node.id] }
  }

  return {
    view: {
      x: Number.isFinite(view.x) ? view.x : 0,
      y: Number.isFinite(view.y) ? view.y : 0,
      scale: Number.isFinite(view.scale) ? clampScale(view.scale) : 1,
    },
    // 画布设置原样带出来，由调用方决定什么时候收进来（撤销快照里没有这一段，别顺手改了全局）
    settings: data.settings ?? null,
    // 面板同理：不进撤销快照；没有这个键就是空表（旧存档）
    board: boardIn(data.board),
    graph: { nodes, edges },
    placed, // 这次现摆的节点：调用方可以落一次盘，把位置记下来
  }
}

// 布局里没有的节点：摆在第一个上游的右边，没有上游（或上游也没摆、成了环）就摆在 center。
// 同一个落点摆了几个就往下错开。
function place(nodes, edges, center) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const loose = (node) => !Number.isFinite(node.x) || !Number.isFinite(node.y)
  const stacked = new Map()
  const placed = []
  const put = (node, up) => {
    const key = up?.id ?? ''
    const count = stacked.get(key) ?? 0
    stacked.set(key, count + 1)
    node.x = up ? up.x + up.w + PLACE_GAP : center.x - node.w / 2
    node.y = (up ? up.y : center.y - node.h / 2) + count * (node.h + PLACE_GAP)
    placed.push(node.id)
  }
  let pending = nodes.filter(loose)
  while (pending.length) {
    const next = []
    for (const node of pending) {
      const up = byId.get(edges.find((edge) => edge.to === node.id)?.from)
      if (up && loose(up)) next.push(node)
      else put(node, up)
    }
    if (next.length === pending.length) put(next.shift(), null)
    pending = next
  }
  return placed
}
