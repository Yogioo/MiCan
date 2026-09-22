// 工作文件夹弹窗：路径输入 + 最近打开 + 浏览文件夹，顺带一个「未保存改动」的确认框。
// 全部画在页面里 —— 浏览器会拦截 prompt / confirm，或者把它们弹在看不见的地方。
const request = async (route, body) => {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`)
  return data
}

const button = (className, text) => {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.textContent = text
  return el
}

// 弹窗骨架：标题、正文槽、错误行、取消/确定。Esc 与点遮罩都算取消。
function openModal({ title, okText, cancelText = '取消' }) {
  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true">' +
    '<div class="modal-title"></div><div class="modal-body"></div><div class="modal-error"></div>' +
    '<div class="modal-actions"></div></div>'

  mask.querySelector('.modal-title').textContent = title
  const actions = mask.querySelector('.modal-actions')
  const cancel = button('modal-cancel', cancelText)
  const ok = button('modal-ok primary', okText)
  actions.append(cancel, ok)
  document.body.append(mask)

  let resolve
  let settled = false
  const promise = new Promise((done) => { resolve = done })
  const finish = (value) => {
    if (settled) return
    settled = true
    document.removeEventListener('keydown', onKey, true)
    mask.remove()
    resolve(value)
  }
  // 捕获阶段接键，别让画布的全局快捷键（Delete / Ctrl+Z）透到弹窗底下
  const onKey = (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    finish(null)
  }

  mask.addEventListener('pointerdown', (event) => { if (event.target === mask) finish(null) })
  cancel.addEventListener('click', () => finish(null))
  document.addEventListener('keydown', onKey, true)

  return { mask, body: mask.querySelector('.modal-body'), error: mask.querySelector('.modal-error'), ok, finish, promise }
}

function listBox(label, className) {
  const wrap = document.createElement('div')
  wrap.className = className
  const caption = document.createElement('div')
  caption.className = 'modal-label'
  caption.textContent = label
  const list = document.createElement('ul')
  list.className = 'modal-list'
  wrap.append(caption, list)
  return { wrap, list }
}

// 路径选择器：一个「浏览…」按钮 + 目录面板（子目录、上一级、盘符），默认收起来不占地方。
// 两个弹窗（工作文件夹 / 运行目录）共用它，点目录只改输入框的值。
function attachBrowser(modal, input) {
  const browseButton = button('modal-browse', '浏览…')
  const browser = document.createElement('div')
  browser.className = 'modal-browser hidden'
  browser.innerHTML =
    '<div class="modal-row browser-head"><span class="browser-path"></span></div>' +
    '<div class="browser-roots"></div><ul class="modal-list browser-dirs"></ul>'
  const up = button('browser-up', '↑ 上一级')
  const pick = button('browser-pick primary', '选这个文件夹')
  browser.querySelector('.browser-head').prepend(up)
  browser.append(pick)

  const dirs = browser.querySelector('.browser-dirs')
  const roots = browser.querySelector('.browser-roots')
  const current = browser.querySelector('.browser-path')
  let browsing = ''

  const showEntry = (path, name) => {
    const li = document.createElement('li')
    li.textContent = name
    li.title = path
    li.addEventListener('click', () => {
      input.value = path
      load(path)
    })
    return li
  }

  async function load(target) {
    modal.error.textContent = ''
    try {
      const data = await request('/api/browse', { path: target || input.value.trim() })
      browsing = data.path
      current.textContent = data.path
      current.title = data.path
      up.disabled = !data.parent
      up.dataset.parent = data.parent ?? ''
      roots.textContent = ''
      for (const root of data.roots) {
        const jump = button('browser-root', root.name)
        jump.addEventListener('click', () => { input.value = root.path; load(root.path) })
        roots.append(jump)
      }
      dirs.textContent = ''
      if (!data.dirs.length) {
        const empty = document.createElement('li')
        empty.className = 'muted'
        empty.textContent = '（没有子文件夹）'
        dirs.append(empty)
      }
      for (const dir of data.dirs) dirs.append(showEntry(dir.path, `${dir.name}/`))
    } catch (error) {
      modal.error.textContent = `列目录失败：${error.message}`
    }
  }

  const closeBrowser = () => {
    browser.classList.add('hidden')
    browseButton.textContent = '浏览…'
  }

  browseButton.addEventListener('click', () => {
    const opening = browser.classList.contains('hidden')
    browser.classList.toggle('hidden', !opening)
    browseButton.textContent = opening ? '收起浏览' : '浏览…'
    if (opening) load(browsing || input.value.trim())
  })
  up.addEventListener('click', () => { if (up.dataset.parent) load(up.dataset.parent) })
  pick.addEventListener('click', () => {
    if (browsing) input.value = browsing
    closeBrowser()
    input.focus()
  })

  return { browseButton, browser }
}

// 问一个工作文件夹路径；回车或「确定」给出路径，取消给 null。error 用来把上一次的失败原因带回来。
export function askWorkspace({ mode, initial = '', recent = [], error = '' }) {
  const creating = mode === 'create'
  const modal = openModal({
    title: creating ? '另存为' : '打开工作文件夹',
    okText: creating ? '保存到这里' : '打开',
  })
  modal.error.textContent = error

  const row = document.createElement('div')
  row.className = 'modal-row'
  const input = document.createElement('input')
  input.className = 'modal-path'
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = creating ? '新文件夹的绝对路径（不存在或为空）' : '工作文件夹的绝对路径'
  input.value = initial
  const { browseButton, browser } = attachBrowser(modal, input)
  row.append(input, browseButton)

  const history = listBox('最近打开', 'modal-recent')
  for (const item of recent) {
    const li = document.createElement('li')
    li.textContent = item
    li.title = item
    li.addEventListener('click', () => {
      input.value = item
      modal.error.textContent = ''
    })
    history.list.append(li)
  }
  if (recent.length) modal.body.append(row, history.wrap)
  else modal.body.append(row)

  modal.body.append(browser)

  const submit = () => {
    const value = input.value.trim()
    if (!value) {
      modal.error.textContent = '请填一个绝对路径，或者用「浏览…」选一个文件夹'
      return
    }
    modal.finish(value)
  }
  input.addEventListener('input', () => { modal.error.textContent = '' })
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  })
  modal.ok.addEventListener('click', submit)

  input.focus()
  if (initial) input.select()
  return modal.promise
}

// 问一个运行目录（全局的、单个命令节点的都走它）：空串表示用回上一层默认，取消给 null。
export function askRunDir({ initial = '', hint = '' } = {}) {
  const modal = openModal({ title: '运行目录', okText: '确定' })
  const label = document.createElement('div')
  label.className = 'modal-label'
  label.textContent = hint

  const row = document.createElement('div')
  row.className = 'modal-row'
  const input = document.createElement('input')
  input.className = 'modal-path'
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = '绝对路径，例如 D:\\work\\demo'
  input.value = initial
  const { browseButton, browser } = attachBrowser(modal, input)
  row.append(input, browseButton)
  modal.body.append(label, row, browser)

  const submit = () => modal.finish(input.value.trim())
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  })
  modal.ok.addEventListener('click', submit)

  input.focus()
  if (initial) input.select()
  return modal.promise
}

// 未保存改动的确认框：回车或「继续」为 true，其余为 false。
export function askDiscard(message) {
  const modal = openModal({ title: '有未保存的改动', okText: '继续', cancelText: '先不' })
  modal.body.textContent = message
  modal.ok.addEventListener('click', () => modal.finish(true))
  const onKey = (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    modal.finish(true)
  }
  document.addEventListener('keydown', onKey, true)
  modal.ok.focus()
  return modal.promise.then((value) => {
    document.removeEventListener('keydown', onKey, true)
    return value === true
  })
}
