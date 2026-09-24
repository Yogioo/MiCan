// 左侧面板：这份画布的属性表。名字进存档，值在 board/<名字>.md。
// 行可以拖到画布上落获取节点；边上那个「写」拖出去是写入节点。
import { board } from '../core/settings.mjs'
import { toWorld } from '../core/view.mjs'

const MIME = 'application/x-mican-slot'

function nextName(taken) {
  if (!taken.has('prop')) return 'prop'
  let n = 2
  while (taken.has(`prop${n}`)) n += 1
  return `prop${n}`
}

export function mountBoard({ getState, onChange, onDropNode }) {
  const el = document.createElement('aside')
  el.id = 'board'
  el.innerHTML =
    '<div class="board-head"><span>面板</span><button type="button" class="board-add" title="加一个属性">+</button></div>' +
    '<div class="board-list"></div>' +
    '<div class="board-note">拖到画布：获取 · 边上「写」：写入</div>'
  document.body.append(el)

  const list = el.querySelector('.board-list')
  const rows = new Map()

  el.querySelector('.board-add').addEventListener('click', () => {
    const name = nextName(new Set(Object.keys(board)))
    commit({ ...board, [name]: '' }, { write: name, value: '' })
  })

  function commit(next, disk) {
    onChange(next, disk)
  }

  function bindDrag(handle, row, kind) {
    handle.draggable = true
    handle.addEventListener('dragstart', (event) => {
      const payload = JSON.stringify({ slot: row.dataset.name, kind })
      event.dataTransfer.setData(MIME, payload)
      event.dataTransfer.setData('text/plain', payload)
      event.dataTransfer.effectAllowed = 'copy'
    })
  }

  function rowOf(name) {
    let row = rows.get(name)
    if (row) return row
    row = document.createElement('div')
    row.className = 'board-row'
    row.innerHTML =
      '<div class="board-grip" title="拖到画布：获取"></div>' +
      '<input class="board-name" spellcheck="false" placeholder="名字">' +
      '<input class="board-value" spellcheck="false" placeholder="值">' +
      '<button type="button" class="board-set" title="拖到画布：写入">写</button>' +
      '<button type="button" class="board-del" title="删除">×</button>'
    const nameInput = row.querySelector('.board-name')
    const valueInput = row.querySelector('.board-value')
    nameInput.value = name
    row.dataset.name = name
    bindDrag(row.querySelector('.board-grip'), row, 'get')
    bindDrag(row.querySelector('.board-set'), row, 'set')

    nameInput.addEventListener('keydown', (event) => event.stopPropagation())
    valueInput.addEventListener('keydown', (event) => event.stopPropagation())
    nameInput.addEventListener('change', () => {
      const from = row.dataset.name
      const to = nameInput.value.trim()
      if (!to || to === from || /[\\/\n]/.test(to)) {
        nameInput.value = from
        return
      }
      if (board[to] !== undefined) {
        nameInput.value = from
        return
      }
      const next = {}
      for (const [key, value] of Object.entries(board)) next[key === from ? to : key] = value
      commit(next, { rename: from, to })
    })
    valueInput.addEventListener('change', () => {
      const key = row.dataset.name
      const value = valueInput.value
      if (value.includes('\n')) return
      commit({ ...board, [key]: value.trim() }, { write: key, value })
    })
    row.querySelector('.board-del').addEventListener('click', () => {
      const key = row.dataset.name
      const next = { ...board }
      delete next[key]
      commit(next, { delete: key })
    })
    list.append(row)
    rows.set(name, row)
    return row
  }

  function render() {
    const names = Object.keys(board)
    el.hidden = !getState().workspace
    const alive = new Set(names)
    for (const name of names) {
      const row = rowOf(name)
      row.dataset.name = name
      const nameInput = row.querySelector('.board-name')
      const valueInput = row.querySelector('.board-value')
      if (document.activeElement !== nameInput) nameInput.value = name
      const live = getState().slots?.[name]
      const shown = live !== undefined ? String(live).split('\n')[0] : board[name] ?? ''
      if (document.activeElement !== valueInput) valueInput.value = shown
    }
    for (const [name, row] of rows) {
      if (alive.has(name)) continue
      row.remove()
      rows.delete(name)
    }
  }

  const viewport = document.getElementById('viewport')
  viewport.addEventListener('dragover', (event) => {
    if (![...event.dataTransfer.types].includes(MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
  viewport.addEventListener('drop', (event) => {
    const raw = event.dataTransfer.getData(MIME) || event.dataTransfer.getData('text/plain')
    if (!raw) return
    event.preventDefault()
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (!payload?.slot || (payload.kind !== 'get' && payload.kind !== 'set')) return
    onDropNode(toWorld(getState().view, event.clientX, event.clientY), payload.kind, payload.slot)
  })

  return { render }
}
