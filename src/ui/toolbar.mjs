// 工具条：落盘状态、另存为、打开、设置、进化、回 100%、工作文件夹、当前缩放比。
// 还有右下角那两个：待命时露开始（从入口跑链），跑起来换成停止。它们不占工具条的地方。
// 没有「保存」按钮：改动一结束就落盘了（ADR-0003），那个点只表示「有写还在路上」。
import { canvas, machine } from '../core/settings.mjs'

export function mountToolbar({ getState, actions }) {
  const dot = document.getElementById('save-dot')
  const zoom = document.getElementById('zoom-value')
  const message = document.getElementById('toolbar-message')
  const workspace = document.getElementById('workspace-path')
  const settings = document.getElementById('btn-settings')
  const start = document.getElementById('btn-start')
  const stop = document.getElementById('btn-stop')
  const evolve = document.getElementById('btn-evolve')

  evolve.addEventListener('click', actions.evolve)
  document.getElementById('btn-save-as').addEventListener('click', actions.saveAs)
  document.getElementById('btn-open').addEventListener('click', actions.openWorkspace)
  settings.addEventListener('click', actions.openSettings)
  document.getElementById('btn-reset').addEventListener('click', actions.resetZoom)
  start.addEventListener('click', actions.start)
  stop.addEventListener('click', actions.stop)

  const SETTINGS_HINT = '命令行、超时、输出上限、界面手感 —— 跟这台机器走，不进画布存档'

  function render(state) {
    // 没东西在跑就是待命：露开始、藏停止；跑起来反过来。
    // 「有东西在跑」看两张表：命令还在跑（running），或者后端还有链在走（runs，两步之间的空档也在跑）。
    const idle = !state.running.size && !state.runs.size
    start.hidden = !idle
    stop.hidden = idle
    const evolving = state.evolve?.active
    start.disabled = Boolean(evolving)
    evolve.disabled = !state.workspace
    evolve.textContent = evolving ? `进化中：${state.evolve.phase || '…'}` : '进化'
    document.body.classList.toggle('evolving', Boolean(evolving))
    dot.classList.toggle('saving', state.saving)
    dot.title = state.saving ? '正在落盘…' : '改动即落盘'
    zoom.textContent = `${Math.round(state.view.scale * 100)}%`
    message.textContent = state.message
    workspace.textContent = state.workspace ?? '未打开工作文件夹'
    workspace.title = state.workspace ?? ''
    // 设置里的值不再铺在工具条上，但「改过没有」一眼看得出来：改过就把按钮点亮，鼠标停上去看是哪些
    const changed = []
    if (machine.shell) changed.push(`命令行 ${machine.shell}`)
    if (canvas.cwd) changed.push(`运行目录 ${canvas.cwd}`)
    settings.classList.toggle('set', changed.length > 0)
    settings.title = changed.length ? `设置：${changed.join('；')}` : SETTINGS_HINT
  }

  return { render }
}
