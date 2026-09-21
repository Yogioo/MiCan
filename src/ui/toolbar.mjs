// 工具条：保存状态、保存、另存为、打开、回 100%、工作文件夹、当前缩放比。
export function mountToolbar({ getState, actions }) {
  const dot = document.getElementById('save-dot')
  const zoom = document.getElementById('zoom-value')
  const message = document.getElementById('toolbar-message')
  const workspace = document.getElementById('workspace-path')

  document.getElementById('btn-save').addEventListener('click', actions.save)
  document.getElementById('btn-save-as').addEventListener('click', actions.saveAs)
  document.getElementById('btn-open').addEventListener('click', actions.openWorkspace)
  document.getElementById('btn-reset').addEventListener('click', actions.resetZoom)

  function render(state) {
    dot.classList.toggle('dirty', state.dirty)
    dot.title = state.dirty ? '有未保存的改动' : '已保存'
    zoom.textContent = `${Math.round(state.view.scale * 100)}%`
    message.textContent = state.message
    workspace.textContent = state.workspace ?? '未打开工作文件夹'
    workspace.title = state.workspace ?? ''
  }

  return { render }
}
