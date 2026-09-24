// 诊断：把工作文件夹的运行历史压成一段 JSON（见 EXTENSION.md）。
// 读 .mican/runs.jsonl、另存的 .mican/runs/*.log 和 mican.json，只读不写。
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const clip = (text, size) => (text.length > size ? `${text.slice(0, size)}…` : text)
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`
const edgeText = (edge) => `${edge.from} -[${edge.label || '兜底'}]-> ${edge.to}`

// 工作文件夹：从本文件往上找 mican.json。扩展总住在某个工作文件夹的 extensions/ 底下。
function findWorkspace() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(path.join(dir, 'mican.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return ''
    dir = up
  }
}

const readLines = (text) =>
  text.split(/\r?\n/).flatMap((row) => {
    if (!row.trim()) return []
    try {
      return [JSON.parse(row)]
    } catch {
      return []
    }
  })

// 动作行（扩展约定）：整行一段带字符串 tool 的 JSON。一步记成「工具 + 第一个字符串参数」。
function actsOf(log) {
  const acts = []
  for (const row of log.split(/\r?\n/)) {
    const text = row.trim()
    if (!text.startsWith('{"tool"')) continue
    try {
      const { tool, args } = JSON.parse(text)
      if (typeof tool !== 'string') continue
      const first = Object.values(args && typeof args === 'object' ? args : {}).find((value) => typeof value === 'string')
      acts.push(first ? `${tool} ${clip(first.trim().replace(/\s+/g, ' '), 80)}` : tool)
    } catch {}
  }
  return acts
}

// 多次运行里都出现的那串连续动作：在至少一半（且不少于 2 次）的运行里出现，只留最长的几串。
function repeatsOf(runs) {
  if (runs.length < 2) return []
  const need = Math.max(2, Math.ceil(runs.length / 2))
  const counts = new Map()
  for (const acts of runs) {
    const seen = new Set()
    for (let size = 2; size <= 8; size += 1) {
      for (let at = 0; at + size <= acts.length; at += 1) seen.add(JSON.stringify(acts.slice(at, at + size)))
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const found = [...counts]
    .filter(([, count]) => count >= need)
    .map(([key, count]) => ({ calls: JSON.parse(key), count }))
    .sort((a, b) => b.calls.length - a.calls.length || b.count - a.count)
  const picked = []
  for (const item of found) {
    const inside = picked.some((have) => JSON.stringify(have.calls).includes(JSON.stringify(item.calls).slice(1, -1)))
    if (!inside) picked.push(item)
    if (picked.length === 3) break
  }
  return picked
}

try {
  const root = findWorkspace()
  if (!root) throw new Error('往上找不到 mican.json：诊断扩展要放在工作文件夹的 extensions/ 底下')
  const canvas = JSON.parse(await fs.readFile(path.join(root, 'mican.json'), 'utf8'))
  const history = readLines(await fs.readFile(path.join(root, '.mican', 'runs.jsonl'), 'utf8').catch(() => ''))
  if (!history.length) {
    say({ ok: false, reason: '还没有运行历史（.mican/runs.jsonl 是空的）' })
    process.exit(0)
  }

  const nodesById = new Map((canvas.nodes ?? []).map((node) => [node.id, node]))
  const execEdges = (canvas.edges ?? []).filter((edge) => edge.kind === 'exec')
  const byNode = new Map()
  for (const entry of history) {
    if (!byNode.has(entry.node)) byNode.set(entry.node, [])
    byNode.get(entry.node).push(entry)
  }

  const nodes = []
  const repeats = []
  for (const [id, entries] of byNode) {
    const node = nodesById.get(id)
    const failed = entries.filter((entry) => entry.failed).length
    let streak = 0
    for (let at = entries.length - 1; at >= 0 && entries[at].failed; at -= 1) streak += 1
    const routes = {}
    for (const entry of entries) if (entry.route !== undefined) routes[entry.route] = (routes[entry.route] ?? 0) + 1
    // 跑链时没往下走、也没失败，而它明明有执行出边：值没对上任何一根边的标签
    const hasOut = execEdges.some((edge) => edge.from === id)
    const stuck = entries.filter((entry) => entry.chain !== id && !entry.failed && entry.route === undefined && hasOut).length
    const acts = []
    for (const entry of entries) {
      if (!entry.log) continue
      const log = await fs.readFile(path.join(root, '.mican', 'runs', entry.log), 'utf8').catch(() => null)
      if (log !== null) acts.push(actsOf(log))
    }
    const item = {
      node: id,
      what: node ? clip(node.extension || node.command || node.kind || '', 60) : '（已不在画布上）',
      runs: entries.length,
      failed,
      streak,
      stuck,
      avgMs: Math.round(entries.reduce((sum, entry) => sum + (entry.ms ?? 0), 0) / entries.length),
      routes,
    }
    if (acts.length) item.avgActs = Math.round((acts.reduce((sum, list) => sum + list.length, 0) / acts.length) * 10) / 10
    nodes.push(item)
    for (const found of repeatsOf(acts)) repeats.push({ node: id, calls: found.calls, runs: found.count, of: acts.length })
  }

  // 从没走过的边：出发节点在跑链时记过去向，这根的标签却一次都没出现
  const unusedEdges = execEdges
    .filter((edge) => {
      const routes = nodes.find((item) => item.node === edge.from)?.routes
      return routes && Object.keys(routes).length && routes[edge.label ?? ''] === undefined
    })
    .map((edge) => ({ from: edge.from, to: edge.to, label: edge.label ?? '' }))

  const day = (at) => new Date(at).toISOString().slice(0, 10)
  const text = [
    `共 ${history.length} 次运行（${day(history[0].at)} ~ ${day(history[history.length - 1].at)}）`,
    ...nodes.map((item) => {
      const parts = [`${item.runs} 次`, `败 ${item.failed}`]
      if (item.streak) parts.push(`眼下连败 ${item.streak}`)
      if (item.stuck) parts.push(`停住 ${item.stuck}`)
      parts.push(`平均 ${seconds(item.avgMs)}`)
      if (item.avgActs !== undefined) parts.push(`平均 ${item.avgActs} 步动作`)
      const routes = Object.entries(item.routes).map(([label, count]) => `${label || '兜底'}×${count}`)
      if (routes.length) parts.push(`去向 ${routes.join(' ')}`)
      return `${item.node}（${item.what}）：${parts.join('，')}`
    }),
    ...(unusedEdges.length ? [`从没走过的边：${unusedEdges.map(edgeText).join('；')}`] : []),
    ...repeats.map((item) => `${item.node} 在 ${item.runs}/${item.of} 次里都做了：${item.calls.join(' → ')}`),
  ].join('\n')

  say({ ok: true, runs: history.length, nodes, unusedEdges, repeats, text })
} catch (error) {
  process.stderr.write(`✗ ${error.message}\n`)
  say({ ok: false, reason: error.message })
  process.exitCode = 1
}
