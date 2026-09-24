// 进化窗口：浮在画布右边，滚动显示这次进化的过程（诊断、pi 每一轮、校验）。
// 进化开始时自己弹出来，做完留着最后那句，点 × 才关。关掉时画布上「进化改过」的标记一并收掉。
import { isActLine } from './nodes.mjs'

export function mountEvolveWindow({ onClose }) {
  const el = document.createElement('div')
  el.id = 'evolve-window'
  el.hidden = true
  el.innerHTML =
    '<div class="evolve-head"><span class="evolve-title">进化</span><span class="evolve-phase"></span>' +
    '<button type="button" class="evolve-close" title="关掉窗口，收掉画布上的标记">×</button></div>' +
    '<pre class="evolve-log"></pre>'
  document.body.append(el)
  const phase = el.querySelector('.evolve-phase')
  const body = el.querySelector('.evolve-log')
  el.querySelector('.evolve-close').addEventListener('click', () => {
    el.hidden = true
    onClose()
  })

  // 动作行是给诊断扩展读的，不铺出来；块边界可能切在一行中间，攒到换行再判
  let pending = ''

  function reset() {
    pending = ''
    body.textContent = ''
  }

  function append(text) {
    if (!text) return
    const rows = `${pending}${text}`.split('\n')
    pending = rows.pop()
    const shown = rows.filter((row) => !isActLine(row))
    if (!shown.length) return
    // 看着底部时跟着滚；往上翻了就别拽回去
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
    body.textContent += `${shown.join('\n')}\n`
    if (atBottom) body.scrollTop = body.scrollHeight
  }

  function open() {
    el.hidden = false
  }

  function render(state) {
    const evolve = state.evolve
    phase.textContent = evolve?.active ? evolve.phase || '…' : evolve?.last ? (evolve.last.ok ? '做完了' : '没做成') : ''
    el.classList.toggle('done', Boolean(evolve && !evolve.active))
  }

  return { open, reset, append, render }
}
