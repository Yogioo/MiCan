// 定时器：后端持有时刻表，到点自己从入口出发跑一整条链（ADR-0005）。
// 它读盘上的 mican.json 找定时器节点和它指的入口节点；时刻表跟着前端每次落盘重新装载
// （api.mjs 在 save / 打开工作文件夹之后调 sync），所以不用轮询文件、也不需要页面在场。
import fs from 'node:fs/promises'
import path from 'node:path'
import { execOutAll } from '../src/core/graph.mjs'
import { CANVAS_FILE } from '../src/core/paths.mjs'
import { nextFireAt, parseSchedule } from '../src/core/schedule.mjs'
import { deserialize } from '../src/core/serialize.mjs'

// 触发记录留一会儿：页面每几秒来问一次（/api/runs 带着 triggers），用它把「上次响没响」摊到节点上。
const KEEP_HITS = 50
const MAX_DELAY_MS = 2 ** 31 - 1 // setTimeout 的上限；比这更远就先不排，下次 sync 再算

export function createScheduler({ getRoot, runChain, isRunning }) {
  const arming = new Map() // timerId -> { key, handle }
  const hits = []
  let seq = 0

  function record(timerId, kind, note) {
    seq += 1
    hits.push({ seq, timerId, at: Date.now(), kind, ...(note ? { note } : {}) })
    if (hits.length > KEEP_HITS) hits.shift()
  }

  // 到点了：这条链还在跑就跳过这一次（只看自己那条链，别的链照跑），否则让运行器走一整条链。
  async function fire(timerId, entryId) {
    if (isRunning(entryId)) {
      record(timerId, 'skipped', '上次跳过了（上一条还在跑）')
      return writeBack(timerId, { at: Date.now(), skipped: true, note: '上次跳过了（上一条还在跑）' })
    }
    const at = Date.now()
    try {
      await runChain(entryId)
      record(timerId, 'fired', '上次触发了')
      await writeBack(timerId, { at, skipped: false, note: '上次触发了' })
    } catch (error) {
      record(timerId, 'failed', `上次没跑起来：${error.message}`)
      await writeBack(timerId, { at, skipped: false, note: `上次没跑起来：${error.message}` })
    }
  }

  // 把这一笔触发补进存档：前端整包落盘时会把它带回来，跟运行结果走的是同一条路。
  // 现读现改，不整包盖回去 —— 画布结构、别的节点的结果都可能刚被前端改过。
  async function writeBack(timerId, result) {
    const root = getRoot()
    if (!root) return
    const file = path.join(root, CANVAS_FILE)
    const raw = await fs.readFile(file, 'utf8').catch(() => null)
    if (raw === null) return
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return // 存档正在被换掉/写坏，这一笔就丢了，下一圈还会再来
    }
    data.results = { ...(data.results ?? {}), [timerId]: result }
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8').catch(() => {})
  }

  function arm(timerId, { entryId, schedule, key }) {
    const delay = nextFireAt(schedule) - Date.now()
    if (delay <= 0 || delay > MAX_DELAY_MS) return
    const handle = setTimeout(async () => {
      arming.delete(timerId)
      await fire(timerId, entryId)
      await sync() // 响过之后重排下一次：间隔型落到下一个相位，每天型落到明天
    }, delay)
    arming.set(timerId, { key, handle })
  }

  function clear() {
    for (const armed of arming.values()) clearTimeout(armed.handle)
    arming.clear()
  }

  // 装载时刻表：按盘上这份画布重排。时间表或它指的入口没变的定时器原地不动 ——
  // 免得每次落盘都把倒计时推后。没连入口、时间表没写对的就不排（界面上会标红）。
  // 落盘可能连着来几次，所以串成一条链做，免得两次装载互相错位。
  let pending = Promise.resolve()
  function sync() {
    pending = pending.then(load).catch(() => {})
    return pending
  }

  async function load() {
    const root = getRoot()
    if (!root) return clear()
    const raw = await fs.readFile(path.join(root, CANVAS_FILE), 'utf8').catch(() => null)
    if (raw === null) return clear()
    let graph
    try {
      graph = deserialize(JSON.parse(raw)).graph
    } catch {
      return clear()
    }

    const wanted = new Map()
    for (const node of graph.nodes) {
      if (node.kind !== 'timer') continue
      const entryId = execOutAll(graph, node.id)[0]?.to
      const schedule = parseSchedule(node.schedule)
      if (!entryId || !schedule) continue
      wanted.set(node.id, { entryId, schedule, key: JSON.stringify([entryId, schedule]) })
    }

    for (const [timerId, armed] of arming) {
      const next = wanted.get(timerId)
      if (next && next.key === armed.key) {
        wanted.delete(timerId) // 原样留着，别推后
        continue
      }
      clearTimeout(armed.handle)
      arming.delete(timerId)
    }
    for (const [timerId, item] of wanted) arm(timerId, item)
  }

  return { sync, clear, triggers: () => hits.slice() }
}
