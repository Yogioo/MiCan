// 节点层：渲染两类节点，处理拖动、缩放、选中、编辑、右键菜单。
import { moveNode, normalizeFileName, resizeNode, setNodeCommand, setNodeCwd, setNodeFile, setNodeText } from '../core/graph.mjs'
import { toWorld } from '../core/view.mjs'
import { renderMarkdown } from './markdown.mjs'

const DRAG_THRESHOLD = 4 // 屏幕像素：移动超过它才算拖动，否则算点击选中

// 本机绝对路径：盘符（C:\、C:/）、UNC（\\server）、或 / 开头；其余当相对工作文件夹
const isAbsolutePath = (value) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value)

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`

export function mountNodes({ getState, update, onConnectStart, onRunCommand, onNewCommandNode, onSetRunDir }) {
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
      el.classList.toggle('selected', state.selection?.id === node.id)
      // 编辑中的节点正文归输入框管，这里不碰
      if (node.kind === 'command') renderCommand(el, node, state)
      else renderText(el, node)
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
    const cmd = el.querySelector('.node-cmd')
    if (cmd.textContent !== node.command) cmd.textContent = node.command
    // 命令里有 {{变量}} / [[变量]] 时节点上留的是模板；鼠标停上去看实际跑了哪条、在哪个目录跑
    const own = node.cwd // 节点自己写的：相对工作文件夹，或本机绝对路径
    const runDir = own || state.settings.cwd || ''
    const notes = []
    if (own) notes.push(`运行目录：${own}（${isAbsolutePath(own) ? '本机绝对路径' : '相对工作文件夹'}）`)
    else if (runDir) notes.push(`运行目录：${runDir}（全局）`)
    const resolved = node.result?.command
    if (resolved && resolved !== node.command) notes.push(`实际执行：${resolved}`)
    cmd.title = notes.join('\n')

    // 运行中看增量、跑完看结果，都没有就空着 —— 命令始终在上面那条里
    const content = running ? node.live ?? '' : node.result ? node.result.output : ''
    const failed = !running && Boolean(node.result?.failed)
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
    body.classList.toggle('need-cmd', !node.command) // 还没写命令时，占位文字改成提示怎么填
    el.classList.toggle('running', running)
    // 设了运行目录（全局或节点）就在脚上带出来，不然跑完就忘了
    const at = own === '.' ? '工作文件夹' : own || runDir
    const foot = [running ? `运行中 · ${seconds(Date.now() - state.running.get(node.id))}` : describeResult(node.result), at && `@ ${at}`]
    el.querySelector('.node-foot').textContent = foot.filter(Boolean).join(' · ')
  }

  function describeResult(result) {
    if (!result) return ''
    const time = new Date(result.at).toTimeString().slice(0, 8)
    const flags = [result.timedOut && '超时', result.truncated && '输出被截断'].filter(Boolean)
    const parts = [`退出码 ${result.code}`, ...flags]
    if (Number.isFinite(result.elapsed)) parts.push(`耗时 ${seconds(result.elapsed)}`)
    return [...parts, time].join(' · ')
  }

  function createElement(node) {
    const el = document.createElement('div')
    el.className = `node kind-${node.kind}`
    el.innerHTML =
      node.kind === 'command'
        ? '<div class="node-cmd"></div><div class="node-body"></div><div class="node-foot"></div><div class="node-port"></div><div class="node-handle"></div>'
        : '<div class="node-title"><span class="node-file"></span></div><div class="node-body"></div><div class="node-port"></div><div class="node-handle"></div>'
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      if (event.target.closest('.node-title')) return // 标题自己管改名
      const current = getState().graph.nodes.find((item) => item.id === el.dataset.id)
      if (!current) return
      if (current.kind === 'command') {
        // 编辑命令用的是整个正文区（够大），上面的命令条先让开
        beginBodyEdit(el, current.command, (value) => update((state) => setNodeCommand(state.graph, current.id, value)), el.querySelector('.node-cmd'))
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

  function openMenu(x, y, items) {
    menu.textContent = ''
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = item.label
      button.addEventListener('click', () => {
        closeMenu()
        item.run()
      })
      menu.append(button)
    }
    menu.hidden = false
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 6)}px`
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 6)}px`
  }

  viewport.addEventListener('contextmenu', (event) => {
    const nodeEl = event.target.closest('.node')
    if (!nodeEl && event.target.closest('.edge-hit')) return // 边：留给浏览器的原生菜单
    event.preventDefault()

    if (!nodeEl) {
      const world = toWorld(getState().view, event.clientX, event.clientY)
      openMenu(event.clientX, event.clientY, [{ label: '新建命令节点', run: () => onNewCommandNode(world) }])
      return
    }

    const node = getState().graph.nodes.find((item) => item.id === nodeEl.dataset.id)
    if (!node || nodeEl.classList.contains('editing')) return
    const items =
      node.kind === 'command'
        ? [
            { label: '运行命令', run: () => onRunCommand(node.id) },
            { label: '设置运行目录…', run: () => onSetRunDir(node.id) },
          ]
        : [{ label: '重命名文件', run: () => beginFileEdit(nodeEl, node) }]
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

    // 右侧连接点：交给边层去拉一条线
    if (event.target.closest('.node-port')) {
      event.stopPropagation()
      onConnectStart(id, event)
      return
    }

    const handle = Boolean(event.target.closest('.node-handle'))
    const origin = { px: event.clientX, py: event.clientY, x: node.x, y: node.y, w: node.w, h: node.h }
    let moved = false

    update((state) => {
      state.selection = { kind: 'node', id }
    })

    el.setPointerCapture(event.pointerId)

    function onMove(moveEvent) {
      const dx = moveEvent.clientX - origin.px
      const dy = moveEvent.clientY - origin.py
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
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
