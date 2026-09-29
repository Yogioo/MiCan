// 运行日志面板（ADR-0031）：工具条上的按钮打开全局时间流，触发节点脚上点开是同一条流、带链过滤。
// 一次运行一折、里面的步骤二折、再展开是那份 stdout / stderr 全文（动作行照 ADR-0021 藏掉）。
// 连续成功的压缩、跟随/暂停、过滤、日期往回翻都在这里。数据由 main.mjs 去 /api/log 拉。
import { firstLine, isBad, outcomeText } from '../core/run-log.mjs'
import { isActLine } from './nodes.mjs'

const BY = { manual: '手动点火', timer: '定时器点火' }
const pad = (value) => String(value).padStart(2, '0')
const clock = (at, withSeconds = true) => {
  const date = new Date(at)
  return withSeconds
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`)
// 一条链跑到连续这么多次还算「正常」，就折起来（ADR-0031 面板那一段）
const FOLD_AFTER = 20

// 一个节点在这个面板里要能一眼认出来：有名字用名字，没有就退回节点 id
const nodeLabel = (step) => step.name || step.node

export function mountRunLogWindow({ actions }) {
  const el = document.createElement('div')
  el.id = 'log-window'
  el.hidden = true
  el.innerHTML =
    '<div class="log-head"><span class="log-title">运行日志</span>' +
    '<select class="log-day" title="往回翻更早的那几份"></select>' +
    '<select class="log-chain" title="只看这条链"></select>' +
    '<label><input type="checkbox" class="log-bad"> 只看异常</label>' +
    '<label><input type="checkbox" class="log-follow" checked> 跟随</label>' +
    '<button type="button" class="log-close" title="关掉面板">×</button></div>' +
    '<div class="log-body"></div>'
  document.body.append(el)
  const $ = (selector) => el.querySelector(selector)
  const body = $('.log-body')
  const dayBox = $('.log-day')
  const chainBox = $('.log-chain')
  const badBox = $('.log-bad')
  const followBox = $('.log-follow')

  let rows = [] // 当天全部行，按读到的顺序
  let items = [] // 折成「一次运行一个单位」之后的那份
  let byRun = new Map()
  let rendered = 0 // 已经处理过（变成元素或按过滤丢掉）的前几个 item
  let dirty = new Set() // 这一趟追加里变过的、已经有元素的 item
  let day = ''
  let days = []
  let chainPick = '' // 面板里选的链过滤
  let follow = true
  let open = false
  let pending = null // 还没够 20 次的连续成功：[{ el, item }]
  let group = null // 已经折起来的连续成功那一段
  const textCache = new Map() // 附件全文：点开才读，读过就留着

  // ---- 形状 ----

  // 追加进来的行折进 items；变过的 item 记进 dirty，等渲染时原地更新。
  function ingest(incoming) {
    for (const row of incoming) {
      if (row.t === 'run') {
        const item = { key: row.runId, kind: 'run', run: row, steps: [], says: [], end: null }
        byRun.set(row.runId, item)
        items.push(item)
        continue
      }
      if (row.t === 'skip') {
        items.push({ key: `skip-${row.seq ?? row.at}`, kind: 'skip', skip: row })
        continue
      }
      const item = byRun.get(row.runId)
      if (!item) continue // run 行在更早那份文件里：半截行，不画
      if (row.t === 'step') item.steps.push(row)
      // 插话（ADR-0032）：挂在那一步上，全文就在行里（它不是值，没有附件）
      else if (row.t === 'say') item.says.push(row)
      else if (row.t === 'end') item.end = row
      if (item.el) dirty.add(item)
    }
  }

  const runOutcome = (item) => item.end?.outcome ?? ''
  const passes = (item) => {
    if (item.kind === 'skip') {
      if (badBox.checked) return true // 跳过算异常，永不折
      return !chainPick || item.skip.chain === chainPick
    }
    if (chainPick && item.run.chain !== chainPick) return false
    // 只看异常时，还在跑的先留着（可能跑成异常）；跑完是好的再把那一行撤掉
    if (badBox.checked) return isBad(runOutcome(item)) || !item.end
    return true
  }

  // ---- 元素 ----

  function chips(parent, list) {
    for (const [text, className] of list) {
      if (!text) continue
      const chip = document.createElement('span')
      chip.className = `log-chip${className ? ` ${className}` : ''}`
      chip.textContent = text
      parent.append(chip)
    }
  }

  function stepRow(step, says = []) {
    const mine = says.filter((row) => row.node === step.node && row.step === step.step)
    const box = document.createElement('details')
    box.className = 'log-step'
    box.dataset.node = step.node
    const sum = document.createElement('summary')
    chips(sum, [
      [String(step.step ?? ''), 'log-step-no'],
      [nodeLabel(step), 'log-node'],
      [step.digest ? `out ${step.digest}` : '', 'log-digest'],
      [mine.length ? `插话 ×${mine.length}` : '', 'log-say-chip'],
      [step.ms !== undefined ? ms(step.ms) : '', 'log-ms'],
      [step.route !== undefined ? `route「${step.route}」` : '', 'log-route'],
      [step.failed ? `退出 ${step.code}` : step.code ? `退出 ${step.code}` : '', step.failed ? 'log-code bad' : 'log-code'],
    ])
    const detail = document.createElement('div')
    detail.className = 'log-detail'
    const focus = document.createElement('button')
    focus.type = 'button'
    focus.className = 'log-focus'
    focus.textContent = '聚焦这个节点'
    focus.addEventListener('click', (event) => {
      event.preventDefault()
      actions.focusNode(step.node)
    })
    const io = document.createElement('span')
    io.className = 'log-io'
    io.textContent =
      [step.in ? '输入快照' : '', step.out ? '输出全文' : '', step.log ? '诊断' : ''].filter(Boolean).join(' · ') ||
      '没有留下全文'
    detail.append(focus, io)
    for (const said of mine) {
      const block = document.createElement('div')
      block.className = `log-say${said.interrupt ? ' cut' : ''}`
      block.textContent = `${clock(said.at)} 人插话（${said.interrupt ? '中断并发送' : '添加并发送'}）：${said.text}`
      detail.append(block)
    }
    box.append(sum, detail)
    // 三折：展开这一层才去读附件（秒级任务下全文可能很多）
    box.addEventListener('toggle', () => {
      if (box.open) loadStepText(box, step)
    })
    return box
  }

  // 附件全文：读完缓存住；被清掉的照实写「全文已清理」，不假装点得开。
  async function loadStepText(box, step) {
    if (box._loaded) return
    box._loaded = true
    const blocks = [
      ['输出', step.out],
      ['诊断', step.log],
      ['输入', step.in],
    ].filter(([, rel]) => rel)
    for (const [label, rel] of blocks) {
      const head = document.createElement('div')
      head.className = 'log-block-head'
      head.textContent = label
      const pre = document.createElement('pre')
      pre.className = 'log-text'
      const detail = box.querySelector('.log-detail')
      detail.append(head, pre)
      if (textCache.has(rel)) {
        pre.textContent = filterActs(textCache.get(rel), label === '诊断')
        continue
      }
      pre.textContent = '读取中…'
      try {
        const text = await actions.readText(rel)
        textCache.set(rel, text)
        pre.textContent = filterActs(text, label === '诊断')
      } catch (error) {
        pre.textContent = `全文已清理（${error.message}）`
      }
    }
  }

  // 动作行是给诊断扩展读的，面板上藏掉（ADR-0021）
  const filterActs = (text, hideActs) =>
    hideActs ? text.split(/\r?\n/).filter((row) => !isActLine(row)).join('\n') : text

  function runRow(item) {
    const box = document.createElement('details')
    box.className = 'log-run'
    box.dataset.run = item.run.runId
    const sum = document.createElement('summary')
    chips(sum, [
      [clock(item.run.at), 'log-time'],
      [item.run.chain ? `「${item.run.chain}」` : '', 'log-chain'],
      [BY[item.run.by] ?? item.run.by ?? '', 'log-by'],
    ])
    const tail = document.createElement('span')
    tail.className = 'log-tail'
    sum.append(tail)
    const steps = document.createElement('div')
    steps.className = 'log-steps'
    box.append(sum, steps)
    box._tail = tail
    box._steps = steps
    updateRun(box, item)
    return box
  }

  function updateRun(box, item) {
    const outcome = runOutcome(item)
    const end = item.end
    const parts = [`${outcomeText(outcome)} ${end?.steps ?? item.steps.length} 步`]
    if (end) parts.push(ms(end.ms ?? 0))
    const wrote = item.steps.reduce((sum, step) => sum + (step.wrote?.length ?? 0), 0)
    if (wrote) parts.push(`写入 ${wrote} 份`)
    if (end && isBad(outcome)) parts.push(firstLine(end.message))
    box._tail.textContent = parts.join(' · ')
    box._tail.title = end?.message ?? ''
    box.classList.toggle('bad', isBad(outcome))
    box.classList.toggle('running', !end)
    box._steps.replaceChildren(...item.steps.map((step) => stepRow(step, item.says)))
  }

  function skipRow(item) {
    const row = document.createElement('div')
    row.className = 'log-skip'
    chips(row, [
      [clock(item.skip.at), 'log-time'],
      ['跳过', 'log-outcome'],
      [item.skip.chain ? `「${item.skip.chain}」` : '', 'log-chain'],
      [item.skip.why === 'evolving' ? '正在进化' : '链身被占', 'log-why'],
    ])
    const note = document.createElement('span')
    note.className = 'log-note'
    note.textContent = item.skip.note ?? ''
    note.title = item.skip.note ?? ''
    row.append(note)
    return row
  }

  // ---- 连续成功压缩 ----

  function groupSummary() {
    return `${clock(group.first, false)}–${clock(group.last, false)} · ${
      group.chain ? `「${group.chain}」` : '没写链名'
    } · 连续 ${group.count} 次跑完 · 无异常`
  }

  function closeGroup() {
    group = null
    pending = null
  }

  function addToGroup(item, box) {
    group.list.append(box)
    group.count += 1
    group.last = item.run.at
    group.el._sum.textContent = groupSummary()
  }

  function promotePending() {
    const entries = pending.entries
    const box = document.createElement('details')
    box.className = 'log-group'
    const sum = document.createElement('summary')
    const list = document.createElement('div')
    list.className = 'log-steps'
    box.append(sum, list)
    entries[0].el.before(box)
    for (const entry of entries) list.append(entry.el)
    group = { el: box, list, sum, chain: pending.chain, count: entries.length, first: entries[0].item.run.at, last: entries.at(-1).item.run.at }
    box._sum = sum
    sum.textContent = groupSummary()
    pending = null
  }

  function appendRun(item, box) {
    const ok = item.end && runOutcome(item) === 'ok'
    if (!ok) {
      closeGroup()
      body.append(box)
      return
    }
    if (group) {
      if (group.chain === item.run.chain) {
        addToGroup(item, box)
        return
      }
      closeGroup()
    }
    if (pending && pending.chain !== item.run.chain) pending = null
    if (!pending) pending = { chain: item.run.chain, entries: [] }
    pending.entries.push({ el: box, item })
    body.append(box)
    if (pending.entries.length >= FOLD_AFTER) promotePending()
  }

  // ---- 渲染 ----

  function renderNew() {
    for (const item of dirty) {
      if (!item.el) continue
      if (!passes(item)) item.el.remove()
      else updateRun(item.el, item)
    }
    dirty.clear()
    for (; rendered < items.length; rendered += 1) {
      const item = items[rendered]
      if (!passes(item)) continue
      const box = item.kind === 'skip' ? skipRow(item) : runRow(item)
      item.el = box
      if (item.kind === 'skip') {
        closeGroup()
        body.append(box)
      } else {
        appendRun(item, box)
      }
    }
    if (follow) body.scrollTop = body.scrollHeight
  }

  // 换过滤 / 换日期：整份重排（这两件事都不常发生，秒级流也只在追加时才走 renderNew）
  function rebuild() {
    body.textContent = ''
    rendered = 0
    dirty = new Set()
    closeGroup()
    for (const item of items) item.el = null
    renderNew()
  }

  // ---- 表头 ----

  function fillDays() {
    const list = days.includes(day) ? days : [day, ...days].filter(Boolean)
    dayBox.replaceChildren(...list.map((value) => new Option(value, value, false, value === day)))
  }

  function fillChains() {
    const names = new Set()
    for (const item of items) {
      const name = item.kind === 'skip' ? item.skip.chain : item.run.chain
      if (name) names.add(name)
    }
    // 过滤里选着的链就算这一天的行里还没有，也留在选项里（当天的第一条还没跑出来）
    if (chainPick) names.add(chainPick)
    const list = ['', ...[...names].sort((a, b) => a.localeCompare(b, 'zh'))]
    chainBox.replaceChildren(...list.map((value) => new Option(value || '全部链', value, false, value === chainPick)))
    chainBox.hidden = names.size < 2 // 只有一条链就不用给选择
  }

  // ---- 对外的几件事 ----

  function load(answer) {
    rows = answer.rows ?? []
    days = answer.days ?? []
    day = answer.day ?? ''
    byRun = new Map()
    items = []
    textCache.clear()
    ingest(rows)
    fillDays()
    fillChains()
    rebuild()
  }

  function append(answer) {
    if (answer.day && answer.day !== day) return // 跨天了：等下一圈整份读
    if (answer.days) days = answer.days
    const incoming = answer.rows ?? []
    if (!incoming.length) return
    rows.push(...incoming)
    ingest(incoming)
    fillChains()
    renderNew()
  }

  chainBox.addEventListener('change', () => {
    chainPick = chainBox.value
    rebuild()
  })
  badBox.addEventListener('change', rebuild)
  dayBox.addEventListener('change', () => actions.reload(dayBox.value))
  followBox.addEventListener('change', () => {
    follow = followBox.checked
    if (follow) body.scrollTop = body.scrollHeight
  })
  // 人往上滚就自动暂停跟随（不被新行顶走）；自己滚回底部再跟上
  body.addEventListener('scroll', () => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
    if (!atBottom && followBox.checked) {
      followBox.checked = false
      follow = false
    }
  })
  $('.log-close').addEventListener('click', () => closeWindow())

  function openWindow(options = {}) {
    if (options.reset) chainPick = ''
    if (typeof options.chain === 'string' && options.chain) chainPick = options.chain
    chainBox.value = chainPick
    el.hidden = false
    open = true
    actions.reload(day)
  }

  function closeWindow() {
    el.hidden = true
    open = false
  }

  function toggle(options) {
    if (open) closeWindow()
    else openWindow(options)
  }

  return { open: openWindow, close: closeWindow, toggle, load, append, rebuild, isOpen: () => open, day: () => day }
}
