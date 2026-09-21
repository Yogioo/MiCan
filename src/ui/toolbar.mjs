// 工具条：保存状态、导出、导入、回 100%、当前缩放比。
export function mountToolbar({ getState, actions }) {
  const dot = document.getElementById('save-dot')
  const zoom = document.getElementById('zoom-value')
  const message = document.getElementById('toolbar-message')

  document.getElementById('btn-export').addEventListener('click', actions.exportJson)
  document.getElementById('btn-import').addEventListener('click', actions.importJson)
  document.getElementById('btn-reset').addEventListener('click', actions.resetZoom)

  function render(state) {
    dot.classList.toggle('pending', state.saveState === 'pending')
    dot.title = state.saveState === 'pending' ? '待保存' : '已保存'
    zoom.textContent = `${Math.round(state.view.scale * 100)}%`
    message.textContent = state.message
  }

  return { render }
}
