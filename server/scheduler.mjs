// 定时器：后端持有时刻表，到点自己从入口出发跑一整条链（ADR-0005）。
// 它读盘上的 mican.json 找定时器节点和它指的入口节点；时刻表跟着前端每次落盘重新装载
// （api.mjs 在 save / 打开工作文件夹之后调 sync），所以不用轮询文件、也不需要页面在场。
import { execOutAll } from '../src/core/graph.mjs'
import { nextFireAt, parseSchedule } from '../src/core/schedule.mjs'
import { loadArchive, patchResults } from './archive.mjs'

// 触发记录留一会儿：页面每几秒来问一次（/api/runs 带着 triggers），用它把「上次响没响」摊到节点上。
const KEEP_HITS = 50
const MAX_DELAY_MS = 2 ** 31 - 1 // setTimeout 的上限；比这更远就先不排，下次 sync 再算

export function createScheduler({ getRoot, runChain, isRunning, isPaused = () => false }) {
  const arming = new Map() // timerId -> { key, handle }
  const hits = []
  let seq = 0

  function record(timerId, kind, note) {
    seq += 1
    hits.push({ seq, timerId, at: Date.now(), kind, ...(note ? { note } : {}) })
    if (hits.length > KEEP_HITS) hits.shift()
  }

  // 到点了：这条链还在跑就跳过这一次（只看链身，别的链照跑），否则让运行器从定时器出发走一整条链。
  async function fire(timerId, headId) {
    // 进化正在改工作文件夹：不写回，只在内存里记一笔
    if (isPaused()) return record(timerId, 'skipped', '上次跳过了（正在进化）')
    if (isRunning(headId)) {
      record(timerId, 'skipped', '上次跳过了（上一条还在跑）')
      return writeBack(timerId, { at: Date.now(), skipped: true, note: '上次跳过了（上一条还在跑）' })
    }
    const at = Date.now()
    try {
      await runChain(timerId)
      record(timerId, 'fired', '上次触发了')
      await writeBack(timerId, { at, skipped: false, note: '上次触发了' })
    } catch (error) {
      record(timerId, 'failed', `上次没跑起来：${error.message}`)
      await writeBack(timerId, { at, skipped: false, note: `上次没跑起来：${error.message}` })
    }
  }

  // 把这一笔触发补进 results：跟运行结果走的是同一条路，页面重开时读得回来。
  async function writeBack(timerId, result) {
    const root = getRoot()
    if (root) await patchResults(root, { [timerId]: result })
  }

  function arm(timerId, { headId, schedule, key }) {
    const delay = nextFireAt(schedule) - Date.now()
    if (delay <= 0 || delay > MAX_DELAY_MS) return
    const handle = setTimeout(async () => {
      arming.delete(timerId)
      await fire(timerId, headId)
      await sync() // 响过之后重排下一次：间隔型落到下一个相位，每天型落到明天
    }, delay)
    arming.set(timerId, { key, handle })
  }

  function clear() {
    for (const armed of arming.values()) clearTimeout(armed.handle)
    arming.clear()
  }

  // 装载时刻表：按盘上这份画布重排。时间表或它连的链没变的定时器原地不动 ——
  // 免得每次落盘都把倒计时推后。没连到会跑的节点、时间表没写对的就不排（界面上会标红）。
  // 落盘可能连着来几次，所以串成一条链做，免得两次装载互相错位。
  let pending = Promise.resolve()
  function sync() {
    pending = pending.then(load).catch(() => {})
    return pending
  }

  async function load() {
    const root = getRoot()
    if (!root) return clear()
    let graph
    try {
      graph = (await loadArchive(root))?.graph
    } catch {
      return clear()
    }
    if (!graph) return clear()

    const wanted = new Map()
    for (const node of graph.nodes) {
      if (node.kind !== 'timer') continue
      const headId = execOutAll(graph, node.id)[0]?.to // 链身从哪个会跑的节点起步（跳过的判据看它）
      const schedule = parseSchedule(node.schedule)
      if (!headId || !schedule) continue
      wanted.set(node.id, { headId, schedule, key: JSON.stringify([headId, schedule]) })
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
