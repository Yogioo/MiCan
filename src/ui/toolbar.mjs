// 工具条：落盘状态、另存为、打开、运行目录、回 100%、工作文件夹、当前缩放比。
// 没有「保存」按钮：改动一结束就落盘了（ADR-0003），那个点只表示「有写还在路上」。
export function mountToolbar({ getState, actions }) {
  const dot = document.getElementById('save-dot')
  const zoom = document.getElementById('zoom-value')
  const message = document.getElementById('toolbar-message')
  const workspace = document.getElementById('workspace-path')
  const runDir = document.getElementById('btn-rundir')

  document.getElementById('btn-save-as').addEventListener('click', actions.saveAs)
  document.getElementById('btn-open').addEventListener('click', actions.openWorkspace)
  document.getElementById('btn-rundir').addEventListener('click', actions.setGlobalRunDir)
  document.getElementById('btn-reset').addEventListener('click', actions.resetZoom)

  function render(state) {
    dot.classList.toggle('saving', state.saving)
    dot.title = state.saving ? '正在落盘…' : '改动即落盘'
    zoom.textContent = `${Math.round(state.view.scale * 100)}%`
    message.textContent = state.message
    workspace.textContent = state.workspace ?? '未打开工作文件夹'
    workspace.title = state.workspace ?? ''
    const cwd = state.settings.cwd
    runDir.classList.toggle('set', Boolean(cwd))
    runDir.title = cwd ? `全局运行目录：${cwd}` : '全局运行目录：跟随工作文件夹'
  }

  return { render }
}
