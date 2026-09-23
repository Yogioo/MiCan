// 节点层：渲染三类节点，处理拖动、缩放、选中、编辑、右键菜单。
import { extensionOf, moveNode, normalizeFileName, resizeNode, setNodeCommand, setNodeConst, setNodeCwd, setNodeFile, setNodePick, setNodeSchedule, setNodeText } from '../core/graph.mjs'
import { CMD_BAR_H, INPUT_ROW } from '../core/geometry.mjs'
import { findExtension, inputsOf, wiredNames } from '../core/inputs.mjs'
import { describeSchedule, dailyText, intervalText, nextFireAt, parseSchedule, scheduleFields } from '../core/schedule.mjs'
import { canvas, machine } from '../core/settings.mjs'
import { toWorld } from '../core/view.mjs'
import { renderMarkdown } from './markdown.mjs'

// 本机绝对路径：盘符（C:\、C:/）、UNC（\\server）、或 / 开头；其余当相对工作文件夹
const isAbsolutePath = (value) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value)

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`
// 脚上的时刻：默认只到分；秒级定时器要看到秒，不然一秒响一次也像什么都没发生
const clockOf = (ts, withSeconds = false) => new Date(ts).toTimeString().slice(0, withSeconds ? 8 : 5)

export function mountNodes({ getState, update, onConnectStart, onRunCommand, onRunChain, onNewCommandNode, onNewExtractNode, onNewEntryNode, onNewTimerNode, onNewExtensionNode, onSetRunDir }) {
  const layer = document.getElementById('nodes')
  const viewport = document.getElementById('viewport')
  const elements = new Map()

  function render(state) {
    const alive = new Set()
    for (const node of state.graph.nodes) {
      alive.add(node.id)
      let el = elements.get(node.id)
      if (!el) {
        el = createElement(node)
        el.dataset.id = node.id
        elements.set(node.id, el)
        layer.append(el)
      }
      el.style.transform = `translate(${node.x}px, ${node.y}px)`
      el.style.width = `${node.w}px`
      el.style.height = `${node.h}px`
      el.classList.toggle('selected', state.selection.has(node.id))
      // 编辑中的节点正文归输入框管，这里不碰
      if (node.kind === 'text') renderText(el, node)
      else if (node.kind === 'extract') renderExtract(el, node)
      else if (node.kind === 'entry') renderEntry(el, node, state)
      else if (node.kind === 'timer') renderTimer(el, node)
      else renderCommand(el, node, state)
    }
    for (const [id, el] of elements) {
      if (alive.has(id)) continue
      el.remove()
      elements.delete(id)
    }
  }

  // ---- 渲染 ----

  function renderText(el, node) {
    const name = node.file.split('/').pop()
    const file = el.querySelector('.node-file')
    if (file.textContent !== name) file.textContent = name
    if (el._text === node.text) return
    const body = el.querySelector('.node-body')
    body.classList.toggle('empty', node.text === '')
    body.innerHTML = renderMarkdown(node.text)
    for (const link of body.querySelectorAll('a[href]')) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
    el._text = node.text
  }

  function renderCommand(el, node, state) {
    const running = state.running.has(node.id)
    // 引用扩展的节点：命令不归用户写，条上显示扩展的名字（ADR-0014）。名字从菜单那份树里现查；
    // 查不到就是坏引用 —— 标红、提示路径，但连线一个不动。
    const ext = extensionOf(node)
    const extName = ext ? findExtension(state.extensions?.items, ext)?.label ?? '' : ''
    // 输入端口区先摆好 —— 正文得按它的高度往下让
    renderInputs(el, node, state)
    const bar = ext ? extName || `找不到扩展：${ext}` : node.command
    const cmd = el.querySelector('.node-cmd')
    if (cmd.textContent !== bar) cmd.textContent = bar
    // 命令里有 {{变量}} / [[变量]] 时节点上留的是模板；鼠标停上去看实际跑了哪条、在哪个目录跑
    const own = node.cwd // 节点自己写的：相对工作文件夹，或本机绝对路径
    const runDir = own || canvas.cwd || ''
    const notes = []
    if (ext) notes.push(extName ? `扩展：${ext}` : `找不到扩展：${ext}（工作文件夹里那个目录还在不在？）`)
    if (own) notes.push(`运行目录：${own}（${isAbsolutePath(own) ? '本机绝对路径' : '相对工作文件夹'}）`)
    else if (runDir) notes.push(`运行目录：${runDir}（全局）`)
    const resolved = node.result?.command
    if (resolved && resolved !== node.command) notes.push(`实际执行：${resolved}`)
    cmd.title = notes.join('\n')

    // 运行中看增量、跑完看结果，都没有就空着 —— 命令始终在上面那条里
    const content = running ? node.live ?? '' : node.result ? node.result.output : ''
    // 停止不算命令自己失败：留到一半的输出该照常看，不染红
    const failed = !running && Boolean(node.result?.failed) && !node.result?.stopped
    const body = el.querySelector('.node-body')
    if (el._content !== content || el._failed !== failed) {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
      body.textContent = content
      body.classList.toggle('empty', !content)
      body.classList.toggle('failed', failed)
      if (atBottom) body.scrollTop = body.scrollHeight // 流式输出跟着尾巴走，但不抢用户翻上去的手
      el._content = content
      el._failed = failed
    }
    body.classList.toggle('need-cmd', !ext && !node.command) // 还没写命令时，占位文字改成提示怎么填
    el.classList.toggle('invalid', Boolean(ext) && !extName) // 坏引用标红（认不出的时间表也用这个类）
    el.classList.toggle('running', running)
    // 设了运行目录（全局或节点）就在脚上带出来，不然跑完就忘了
    const at = own === '.' ? '工作文件夹' : own || runDir
    const foot = []
    if (running) foot.push(`运行中 · ${seconds(Date.now() - state.running.get(node.id))}`)
    else {
      // 「没跑」和「跑出来是空的」得分得清，所以未运行跟上次的结果并列显示
      if (node.skipped) foot.push('未运行')
      const known = describeResult(node.result)
      if (known) foot.push(known)
    }
    if (at) foot.push(`@ ${at}`)
    el.querySelector('.node-foot').textContent = foot.join(' · ')
  }

  // 命令节点的输入端口：命令里（扩展节点则是清单的 args 里）有几个 {{名字}} / [[名字]]，
  // 左边就排几行，每行 [端口][名字][填值的框]。同一个变量有两条路：从端口拉线连别的节点，
  // 或者直接在框里填常量 —— 连了边的那一行框就让位（边是更明确的来源）。
  function renderInputs(el, node, state) {
    const box = el.querySelector('.node-inputs')
    if (!box) return
    const inputs = inputsOf(node, state.extensions)
    const wired = wiredNames(state.graph, node.id)
    // 清单里给这个输入写的默认值：框空着的时候它顶上（存盘里没有它，后端运行时现补）
    const declared = node.extension ? findExtension(state.extensions?.items, node.extension) : null
    // 端口只在名单变了的时候重建 —— 每次重绘都重建的话，正在填的那个框会被抽走
    const signature = inputs.map((port) => `${port.name}${port.file ? '(f)' : ''}`).join('|')
    if (el._ports !== signature) {
      box.textContent = ''
      for (const [index, item] of inputs.entries()) box.append(portRow(el, item, index))
      el._ports = signature
    }
    for (const row of box.children) {
      const field = row.querySelector('.node-port-value')
      const fromEdge = wired.has(row.dataset.name)
      const fallback = declared?.defaults?.[row.dataset.name] ?? ''
      field.disabled = fromEdge
      field.placeholder = fromEdge ? '由连线提供' : fallback ? `默认 ${fallback}` : '填值'
      const wanted = fromEdge ? '' : node.consts?.[row.dataset.name] ?? ''
      if (document.activeElement !== field && field.value !== wanted) field.value = wanted
    }
    // 端口区把正文往下挤；没有输入就还回去，别留一条白缝
    el.querySelector('.node-body').style.top = inputs.length ? `${CMD_BAR_H + inputs.length * INPUT_ROW.step}px` : ''
  }

  // 一行输入端口：圆点（拉线、接线的抓手）、名字、填值的框
  function portRow(el, item, index) {
    const row = document.createElement('div')
    row.className = 'node-port-row'
    row.dataset.name = item.name

    const port = document.createElement('div')
    port.className = 'node-port port-data port-in'
    port.dataset.kind = 'data'
    port.dataset.name = item.name
    port.dataset.index = String(index)
    port.title = `输入「${item.name}」：从这里拉到别的节点上，或者从别处连过来`

    const name = document.createElement('span')
    name.className = 'node-port-name'
    name.textContent = item.name
    if (item.file) name.title = '这一路要的是文件路径（[[名字]]），不是正文'

    const value = document.createElement('input')
    value.className = 'node-port-value'
    value.spellcheck = false
    value.placeholder = '填值'
    // 在框里打字别触发全局快捷键（Delete 删节点那一套）
    value.addEventListener('keydown', (event) => event.stopPropagation())
    value.addEventListener('change', () => {
      const current = getState().graph.nodes.find((entry) => entry.id === el.dataset.id)
      if (current) update((draft) => setNodeConst(draft.graph, current.id, item.name, value.value))
    })

    row.append(port, name, value)
    return row
  }

  function describeResult(result) {
    if (!result) return ''
    const time = new Date(result.at).toTimeString().slice(0, 8)
    const flags = [result.timedOut && '超时', result.truncated && '输出被截断'].filter(Boolean)
    const parts = [result.stopped ? '已停止' : `退出码 ${result.code}`, ...flags]
    if (Number.isFinite(result.elapsed)) parts.push(`耗时 ${seconds(result.elapsed)}`)
    return [...parts, time].join(' · ')
  }

  // 提取节点：顶上一条取法（跟命令条同位），中间是取出来的值，底部一条时间。
  // 它不跑进程，所以没有退出码、没有运行中、也没有入口。
  function renderExtract(el, node) {
    const spec = node.pick ?? ''
    const bar = el.querySelector('.node-cmd')
    if (bar.textContent !== spec) bar.textContent = spec
    bar.title = spec ? `取法：${spec}` : '双击填写取法，如 json:isFull'

    const content = node.result?.output ?? ''
    const body = el.querySelector('.node-body')
    if (el._content !== content || el._failed !== false) {
      body.textContent = content
      body.classList.toggle('empty', !content)
      el._content = content
      el._failed = false
    }
    body.classList.toggle('need-cmd', !spec) // 还没填取法时，占位文字改成提示怎么填
    el.classList.toggle('running', false)
    const at = node.result ? new Date(node.result.at).toTimeString().slice(0, 8) : ''
    el.querySelector('.node-foot').textContent = at ? `取值 · ${at}` : ''
  }

  // 入口节点：链的起点。它没有进程、没有值，只有一根执行出边；将来子图的入口也是它。
  function renderEntry(el, node, state) {
    const body = el.querySelector('.node-body')
    if (el._content !== '链从这里开始') {
      body.textContent = '链从这里开始'
      el._content = '链从这里开始'
    }
    // 入口自己不跑，但「有一条链正从这儿走」看它 —— 运行记录里的 nodeId 就是它
    const active = [...state.runs.values()].some((run) => run.nodeId === node.id)
    el.classList.toggle('running', active)
    el.querySelector('.node-foot').textContent = active ? '运行中' : ''
  }

  // 定时器节点：顶上写人话（「每 30 分钟」），中间就是控件 —— 模式、数值或时刻直接在节点上点，
  // 脚上写下次什么时候、上一回响没响。控件写回去的还是那一行时间表文本（schedule.mjs 解析）。
  function renderTimer(el, node) {
    const text = node.schedule ?? ''
    const schedule = parseSchedule(text)
    const bar = el.querySelector('.node-cmd')
    const label = schedule ? describeSchedule(schedule) : `时间表认不出来：${text}`
    if (el._bar !== label) {
      bar.textContent = label
      el._bar = label
    }
    el.classList.toggle('invalid', !schedule) // 认不出来就标红，别等到点才发现不响

    fillTimerForm(el, schedule)

    const foot = []
    // 秒级的时间表就把秒带出来，不然同一分钟里刷多少次都是一个样子
    const precise = schedule?.mode === 'interval' && schedule.every < 60000
    if (schedule) foot.push(`下次 ${clockOf(nextFireAt(schedule), precise)}`)
    if (node.result?.at) foot.push(`上次 ${clockOf(node.result.at, precise)}${node.result.skipped ? '（跳过）' : ''}`)
    const footEl = el.querySelector('.node-foot')
    footEl.textContent = foot.join(' · ')
    footEl.title = node.result?.note ?? '' // 「上一条还在跑」这类话太长，收在悬停里
  }

  // 控件按时间表填。模式按钮与哪一行显着每次都摆正；值只填「没在编辑的」那个控件 ——
  // 正在输入的手不打断（跑链的时候界面每半秒会重绘一次）。
  function fillTimerForm(el, schedule) {
    const fields = scheduleFields(schedule)
    const mode = fields?.mode ?? 'interval'
    for (const button of el.querySelectorAll('.timer-modes button')) button.classList.toggle('on', button.dataset.mode === mode)
    el.querySelector('.timer-interval').hidden = mode !== 'interval'
    el.querySelector('.timer-daily').hidden = mode !== 'daily'
    const fill = (input, value) => {
      if (document.activeElement !== input) input.value = value
    }
    if (mode === 'daily') fill(el.querySelector('.timer-at'), fields.at)
    else if (fields) {
      fill(el.querySelector('.timer-count'), String(fields.count))
      fill(el.querySelector('.timer-unit'), fields.unit)
    }
  }

  // 控件上的改动落到节点上（写回去的还是那一行文本）。认不出来的（比如数值被清空），
  // 就当没动过、把控件按现在这份填回去 —— 不静默改掉用户写下的东西。
  function commitSchedule(el, text) {
    const node = getState().graph.nodes.find((item) => item.id === el.dataset.id)
    if (!node) return
    if (!parseSchedule(text) || text === node.schedule) render(getState())
    else update((state) => setNodeSchedule(state.graph, node.id, text))
  }

  // 连接点：都会落在节点顶部标题条那一条水平线上 —— 执行边从右端出去、从左端进来，
  // 链看起来是一条贯的线。会跑的节点还有一个数据端口（按比例落在右侧）；
  // 入口和定时器只有执行出边。
  const EXEC_PORT = '<div class="node-port port-exec" data-kind="exec" title="执行端口：连下一个会跑的节点"></div>'
  // 左端的「入」圆点只看不拉：连线还是从上游节点的出端口拉过来。
  const EXEC_IN = '<div class="node-port port-exec port-exec-in" title="执行入口：上一步从这儿进来"></div>'
  const RUN_PORTS =
    EXEC_PORT +
    EXEC_IN +
    '<div class="node-port port-data" data-kind="data" title="数据端口：连文本节点或会跑的节点"></div>'
  const TEXT_PORT = '<div class="node-port port-data" data-kind="data" title="数据端口：把正文喂给会跑的节点"></div>'

  // 定时器的控件：模式（固定间隔 / 每天）、间隔的数值与单位、每天的时刻。
  // 这里是模板，值由 fillTimerForm 填；改控件打的是同一条路 —— 写回一行时间表文本。
  const TIMER_FORM =
    '<div class="timer-row timer-modes">' +
    '<button type="button" data-mode="interval">固定间隔</button>' +
    '<button type="button" data-mode="daily">每天</button>' +
    '</div>' +
    '<div class="timer-row timer-interval">' +
    '<input class="timer-count" type="number" min="1" max="999" step="1" value="30">' +
    '<select class="timer-unit"><option value="秒">秒</option><option value="分钟">分钟</option><option value="小时">小时</option></select>' +
    '</div>' +
    '<div class="timer-row timer-daily"><input class="timer-at" type="time" value="09:00"></div>'

  function createElement(node) {
    const el = document.createElement('div')
    el.className = `node kind-${node.kind}`
    el.innerHTML =
      node.kind === 'text'
        ? `<div class="node-title"><span class="node-file"></span></div><div class="node-body"></div>${TEXT_PORT}<div class="node-handle"></div>`
        : node.kind === 'entry'
          ? `<div class="node-title"><span class="node-kind">入口</span></div><div class="node-body"></div><div class="node-foot"></div>${EXEC_PORT}<div class="node-handle"></div>`
          : node.kind === 'timer'
            ? `<div class="node-cmd"></div><div class="node-body"><div class="timer-form">${TIMER_FORM}</div></div><div class="node-foot"></div>${EXEC_PORT}<div class="node-handle"></div>`
            : node.kind === 'command'
              ? `<div class="node-cmd"></div><div class="node-inputs"></div><div class="node-body"></div><div class="node-foot"></div>${RUN_PORTS}<div class="node-handle"></div>`
              : `<div class="node-cmd"></div><div class="node-body"></div><div class="node-foot"></div>${RUN_PORTS}<div class="node-handle"></div>`

    if (node.kind === 'timer') {
      const form = el.querySelector('.timer-form')
      // 控件上的按下不归节点管，否则点一下就开始拖节点
      form.addEventListener('pointerdown', (event) => event.stopPropagation())
      form.addEventListener('dblclick', (event) => event.stopPropagation())
      const count = form.querySelector('.timer-count')
      const unit = form.querySelector('.timer-unit')
      const at = form.querySelector('.timer-at')
      const saveInterval = () => commitSchedule(el, intervalText(count.value, unit.value))
      for (const button of form.querySelectorAll('.timer-modes button')) {
        button.addEventListener('click', () =>
          button.dataset.mode === 'daily' ? commitSchedule(el, dailyText(at.value)) : saveInterval(),
        )
      }
      count.addEventListener('change', saveInterval)
      unit.addEventListener('change', saveInterval)
      at.addEventListener('change', () => commitSchedule(el, dailyText(at.value)))
    }
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      if (event.target.closest('.node-title')) return // 标题自己管改名
      const current = getState().graph.nodes.find((item) => item.id === el.dataset.id)
      if (!current) return
      if (current.kind === 'command') {
        // 引用扩展的节点没有可写的命令：要改就改扩展目录里那份清单（ADR-0014）
        if (extensionOf(current)) return
        // 编辑命令用的是整个正文区（够大），上面的命令条先让开
        beginBodyEdit(el, current.command, (value) => update((state) => setNodeCommand(state.graph, current.id, value)), el.querySelector('.node-cmd'))
      } else if (current.kind === 'extract') {
        // 取法跟命令一样：也是整个正文区当编辑面，上面的取法条先让开
        beginBodyEdit(el, current.pick ?? '', (value) => update((state) => setNodePick(state.graph, current.id, value)), el.querySelector('.node-cmd'))
      } else if (current.kind === 'timer') {
        // 定时器：控件就长在节点上，不用再开一层编辑面（双击落在控件上由它自己处理）
      } else if (current.kind === 'entry') {
        // 入口上没有可编辑的东西：它只是个标记，跑链走右键菜单
      } else {
        beginBodyEdit(el, current.text, (value) => update((state) => setNodeText(state.graph, current.id, value)))
      }
    })
    if (node.kind === 'text') {
      el.querySelector('.node-title').addEventListener('dblclick', (event) => {
        event.stopPropagation()
        const current = getState().graph.nodes.find((item) => item.id === el.dataset.id)
        if (current) beginFileEdit(el, current)
      })
    }
    return el
  }

  // ---- 编辑 ----

  // 正文：界面与渲染态完全同位同字号，失焦保存、Esc 取消。
  function beginBodyEdit(el, original, commitText, hideEl = null) {
    if (el.classList.contains('editing')) return
    const body = el.querySelector('.node-body')
    const input = document.createElement('textarea')
    input.className = 'node-input'
    input.value = original
    input.spellcheck = false

    el.classList.add('editing')
    body.textContent = ''
    body.append(input)
    if (hideEl) hideEl.hidden = true
    input.focus()
    input.setSelectionRange(original.length, original.length)

    let finished = false
    function finish(commit) {
      if (finished) return
      finished = true
      const value = input.value
      input.remove()
      el.classList.remove('editing')
      if (hideEl) hideEl.hidden = false
      el._text = null // 强制重画正文
      el._content = null
      if (commit && value !== original) commitText(value)
      else render(getState())
    }

    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (event) => {
      event.stopPropagation() // 编辑时不把按键交给全局快捷键（Delete、Ctrl+Z 等）
      if (event.key === 'Escape') finish(false)
    })
  }

  // 文件名：标题上就地改名，提交时按 normalizeFileName 兜一遍。
  function beginFileEdit(el, node) {
    if (el.classList.contains('editing')) return
    const span = el.querySelector('.node-file')
    const original = node.file.split('/').pop()
    const input = document.createElement('input')
    input.className = 'node-file-input'
    input.value = original
    input.spellcheck = false

    el.classList.add('editing')
    span.hidden = true
    span.after(input)
    input.focus()
    input.select()

    let finished = false
    function finish(commit) {
      if (finished) return
      finished = true
      const next = input.value
      input.remove()
      span.hidden = false
      el.classList.remove('editing')
      const file = commit ? normalizeFileName(next) : null
      if (file && file !== original) update((state) => setNodeFile(state.graph, node.id, `docs/${file}`))
      else render(getState())
    }

    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') finish(false)
      if (event.key === 'Enter') finish(true)
    })
  }

  // ---- 右键菜单 ----

  const menu = document.createElement('div')
  menu.id = 'menu'
  menu.hidden = true
  document.body.append(menu)

  function closeMenu() {
    menu.hidden = true
  }

  // 带 items 的那一项是子菜单：点进去把菜单内容换成那一层，顶上留一条「← 返回」。
  // 不另开浮层 —— 扩展的分组可以有好几层，浮层得算位置、还得处理出界。
  function openMenu(x, y, items, back = null) {
    menu.textContent = ''
    if (back) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'menu-back'
      button.textContent = '← 返回'
      button.addEventListener('click', () => openMenu(x, y, back.items, back.back))
      menu.append(button)
    }
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = item.items ? `${item.label} ▸` : item.label
      button.addEventListener('click', () => {
        if (item.items) return openMenu(x, y, item.items, { items, back })
        closeMenu()
        item.run()
      })
      menu.append(button)
    }
    menu.hidden = false
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 6)}px`
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 6)}px`
  }

  // 扩展树 → 菜单项。分组往下开子菜单，扩展项点一下就在画布上落一个引用它的命令节点。
  const extensionMenu = (items, world) =>
    items.map((item) =>
      item.children
        ? { label: item.label, items: extensionMenu(item.children, world) }
        : { label: item.label, run: () => onNewExtensionNode(world, item.path) },
    )

  viewport.addEventListener('contextmenu', (event) => {
    const nodeEl = event.target.closest('.node')
    if (!nodeEl && event.target.closest('.edge-hit')) return // 边：留给浏览器的原生菜单
    event.preventDefault()

    if (!nodeEl) {
      const world = toWorld(getState().view, event.clientX, event.clientY)
      const items = [
        { label: '新建命令节点', run: () => onNewCommandNode(world) },
        { label: '新建提取节点', run: () => onNewExtractNode(world) },
        { label: '新建入口节点', run: () => onNewEntryNode(world) },
        { label: '新建定时器节点', run: () => onNewTimerNode(world) },
      ]
      // 扩展：工作文件夹里扫出来的那些（没打开文件夹就没有），分组自己会往下开
      const extensions = extensionMenu(getState().extensions?.items ?? [], world)
      if (extensions.length) items.push({ label: '新建扩展节点', items: extensions })
      openMenu(event.clientX, event.clientY, items)
      return
    }

    const node = getState().graph.nodes.find((item) => item.id === nodeEl.dataset.id)
    if (!node || nodeEl.classList.contains('editing')) return
    const items = []
    if (node.kind === 'command') {
      items.push({ label: '运行命令', run: () => onRunCommand(node.id) })
      items.push({ label: '设置运行目录…', run: () => onSetRunDir(node.id) })
    } else if (node.kind === 'extract') {
      // 提取节点没进程可跑，能做的只有「按现在的值重新取一次」
      items.push({ label: '运行提取', run: () => onRunCommand(node.id) })
    } else if (node.kind === 'entry' || node.kind === 'timer') {
      // 两枚触发节点都是链的起点，差别只在「什么时候点火」：入口靠人手，定时器到点自己跑。
      // 定时器也能手动点一下 —— 想验证配好的链不用等到点。
      items.push({ label: node.kind === 'timer' ? '立即跑一次' : '运行链路', run: () => onRunChain(node.id) })
    } else if (node.kind === 'text') {
      items.push({ label: '重命名文件', run: () => beginFileEdit(nodeEl, node) })
    }
    if (!items.length) return
    openMenu(event.clientX, event.clientY, items)
  })

  // 点别处、按 Esc 都关掉菜单；菜单自己身上的 pointerdown 不算
  window.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !event.target.closest('#menu')) closeMenu()
  }, true)
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu()
  })

  // ---- 拖动 / 缩放 / 选中 ----

  function onPointerDown(event) {
    if (event.button !== 0) return
    const el = event.currentTarget
    if (el.classList.contains('editing')) return // 编辑态交给输入框
    event.stopPropagation() // 不触发画布平移

    const id = el.dataset.id
    const node = getState().graph.nodes.find((item) => item.id === id)
    if (!node) return

    // 连接点：交给边层去拉一条线，拉哪一种由端口决定。
    // 命名输入端口还要把名字带过去 —— 建出来的边标签就是它，而且从端口往别处拉时方向是反的。
    const port = event.target.closest('.node-port')
    if (port) {
      event.stopPropagation()
      const name = port.dataset.name ?? ''
      const into = name ? { into: true, label: name, index: Number(port.dataset.index ?? 0) } : null
      onConnectStart(id, port.dataset.kind ?? 'data', event, into)
      return
    }
    // 输入端口的填值框：归它自己，别当成拖节点
    if (event.target.closest('.node-port-row')) {
      event.stopPropagation()
      return
    }

    const handle = Boolean(event.target.closest('.node-handle'))
    const origin = { px: event.clientX, py: event.clientY, x: node.x, y: node.y, w: node.w, h: node.h }
    let moved = false

    update((state) => {
      state.selection = new Set([id])
    })

    el.setPointerCapture(event.pointerId)

    function onMove(moveEvent) {
      const dx = moveEvent.clientX - origin.px
      const dy = moveEvent.clientY - origin.py
      if (!moved && Math.hypot(dx, dy) < machine.dragThreshold) return
      moved = true
      const { scale } = getState().view
      if (handle) {
        update((state) => resizeNode(state.graph, id, origin.w + dx / scale, origin.h + dy / scale))
      } else {
        update((state) => moveNode(state.graph, id, origin.x + dx / scale, origin.y + dy / scale))
      }
    }

    function onEnd() {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onEnd)
      el.removeEventListener('pointercancel', onEnd)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onEnd)
    el.addEventListener('pointercancel', onEnd)
  }

  return { render }
}
