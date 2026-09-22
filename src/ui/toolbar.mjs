// 工具条：落盘状态、另存为、打开、设置、回 100%、工作文件夹、当前缩放比。
// 还有右下角那个「停止」：它只在有东西在跑的时候出现，所以不占工具条的地方。
// 没有「保存」按钮：改动一结束就落盘了（ADR-0003），那个点只表示「有写还在路上」。
import { canvas, machine } from '../core/settings.mjs'

export function mountToolbar({ getState, actions }) {
  const dot = document.getElementById('save-dot')
  const zoom = document.getElementById('zoom-value')
  const message = document.getElementById('toolbar-message')
  const workspace = document.getElementById('workspace-path')
  const settings = document.getElementById('btn-settings')
  const stop = document.getElementById('btn-stop')

  document.getElementById('btn-save-as').addEventListener('click', actions.saveAs)
  document.getElementById('btn-open').addEventListener('click', actions.openWorkspace)
  settings.addEventListener('click', actions.openSettings)
  document.getElementById('btn-reset').addEventListener('click', actions.resetZoom)
  stop.addEventListener('click', actions.stop)

  const SETTINGS_HINT = '命令行、超时、输出上限、界面手感 —— 跟这台机器走，不进画布存档'

  function render(state) {
    // 有命令在跑、或者有一条链正在走，它就露头。跑的是哪些节点，节点自己脚上写着
    stop.hidden = !state.running.size && !state.chain
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
