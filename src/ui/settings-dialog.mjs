// 设置窗口：两层配置都在这儿 —— 跟这台机器走的（后端存）和跟这份画布走的（进存档，由调用方收）。
// 每一项都写在 core/settings.mjs 的表里：这里只按表画（名字、单位、说明、默认值、范围全来自表），
// 加一项配置不用动这个文件。常用项直接列出，细枝末节收在「细节」里。
//
// 值从调用方传进来的当前设置读（machine / canvas 永远是完整的，没设过就是表里的默认值）——
// 别去用后端的回参：手感那些键后端不认识，没存过就不回。
import { CANVAS_FIELDS, MACHINE_FIELDS, shownFields } from '../core/settings.mjs'
import { attachBrowser, button, openModal, request } from './workspace-dialog.mjs'

// 一行：名字 + 控件（带单位） + 说明（说明里带上默认值，省得挨个去试）
function fieldRow(modal, field, value) {
  const wrap = document.createElement('div')
  wrap.className = 'set-row'

  const name = document.createElement('div')
  name.className = 'set-name'
  name.textContent = field.label
  if (field.hint) name.title = field.hint

  const control = document.createElement('div')
  control.className = 'set-control'
  let read
  let set

  if (field.kind === 'shell') {
    const select = document.createElement('select')
    const options = [['', '跟这台机器的默认'], ...field.options.map((item) => [item, item])]
    for (const [optionValue, text] of options) {
      const option = document.createElement('option')
      option.value = optionValue
      option.textContent = text
      select.append(option)
    }
    select.value = String(value ?? '')
    control.append(select)
    read = () => select.value
    set = (next) => { select.value = String(next ?? '') }
  } else {
    const input = document.createElement('input')
    input.className = 'modal-path'
    input.type = field.kind === 'path' ? 'text' : 'number'
    input.spellcheck = false
    if (field.kind !== 'path') {
      input.min = String(field.min)
      input.max = String(field.max)
      input.step = field.kind === 'number' ? 'any' : '1'
    }
    input.value = String(value ?? '')
    control.append(input)
    if (field.unit) {
      const unit = document.createElement('span')
      unit.className = 'set-unit'
      unit.textContent = field.unit
      control.append(unit)
    }
    read = () => input.value.trim()
    set = (next) => { input.value = String(next ?? '') }
  }

  const note = document.createElement('div')
  note.className = 'set-note'
  note.textContent = [...(field.hint ? [field.hint] : []), `默认 ${field.def === '' ? '空' : field.def}${field.unit ?? ''}`].join(' · ')

  wrap.append(name, control, note)

  // 路径：后面跟一个「浏览…」，面板撑满整行
  if (field.kind === 'path') {
    const { browseButton, browser } = attachBrowser(modal, control.querySelector('input'))
    control.append(browseButton)
    wrap.append(browser)
  }

  return { wrap, read, set }
}

// 一个分组（层里的「命令 / 界面 / …」，或展开的「细节」）
function groupBox(container, name, hint) {
  const box = document.createElement('div')
  box.className = 'set-group'
  const caption = document.createElement('div')
  caption.className = 'set-group-name'
  caption.textContent = name
  if (hint) caption.title = hint
  box.append(caption)
  container.append(box)
  return box
}

// 「导入内置插件」：把随软件带走的那份样本（builtin/extensions/）拷进这份工作文件夹。
// 它只是搬目录，不是第二条查找路径（ADR-0012）—— 搬完刷新右键菜单，节点引用的还是工作文件夹里那份。
// 重名的先问：跳过还是覆盖，默认跳过（改过的文件不该被默默抹掉）。
function extensionImport(box, { hasWorkspace, onImported }) {
  const group = groupBox(box, '扩展')
  const start = button('set-restore', '导入内置插件…')
  const status = document.createElement('div')
  status.className = 'set-note'
  status.textContent = hasWorkspace
    ? '拷进工作文件夹就立刻生效，跟这个窗口的保存 / 取消无关'
    : '先打开一个工作文件夹 —— 插件得有地方放'
  start.disabled = !hasWorkspace
  group.append(start, status)

  start.addEventListener('click', async () => {
    start.disabled = true
    status.textContent = '正在读内置库…'
    let library
    try {
      library = await request('/api/library', {})
    } catch (error) {
      status.textContent = `读内置库失败：${error.message}`
      start.disabled = false
      return
    }
    if (!library.items.length) {
      status.textContent = '内置库里还没有插件'
      return
    }

    // 一行 = [勾] 名字 · [新增 | 跳过/覆盖] · 说明
    const list = document.createElement('div')
    const rows = library.items.map((item) => {
      const row = document.createElement('div')
      row.className = 'set-row'
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = true
      const label = document.createElement('label')
      label.className = 'set-name set-check'
      const name = document.createElement('span')
      name.textContent = ` ${item.label}`
      label.append(check, name)
      const control = document.createElement('div')
      control.className = 'set-control'
      let overwrite = false
      if (item.exists) {
        const choice = document.createElement('select')
        for (const [value, text] of [['skip', '跳过'], ['over', '覆盖']]) {
          const option = document.createElement('option')
          option.value = value
          option.textContent = text
          choice.append(option)
        }
        choice.addEventListener('change', () => { overwrite = choice.value === 'over' })
        control.append(choice)
      } else {
        control.textContent = '新增'
      }
      const note = document.createElement('div')
      note.className = 'set-note'
      note.textContent = item.description
      row.append(label, control, note)
      list.append(row)
      return { item, check, overwrite: () => overwrite }
    })

    const go = button('set-restore', '导入选中的')
    group.replaceChildren(go, list, status)
    go.addEventListener('click', async () => {
      go.disabled = true
      let done = 0
      let skipped = 0
      const bad = []
      for (const row of rows) {
        if (!row.check.checked) continue
        if (row.item.exists && !row.overwrite()) {
          skipped += 1
          continue
        }
        try {
          await request('/api/import', { path: row.item.path, overwrite: row.overwrite() })
          done += 1
        } catch (error) {
          bad.push(`${row.item.label}：${error.message}`)
        }
      }
      status.textContent = [`导入 ${done} 个`, skipped ? `跳过 ${skipped} 个` : '', ...bad].filter(Boolean).join(' · ')
      go.disabled = false
      if (done) onImported?.()
    })
  })
}

export async function askSettings({ current, hasWorkspace = false, onImported } = {}) {
  const modal = openModal({ title: '设置', okText: '保存', wide: true })
  const readers = []

  // 命令行可选的名字由后端给（认哪些名字是后端的事）；其余的项这里不需要后端
  let shells = []
  try {
    const remote = await request('/api/settings', {})
    if (Array.isArray(remote.shells)) shells = remote.shells
  } catch {
    // 拿不到就当只有一个「跟机器默认」
  }

  // 一层：机器 / 画布。extra 在这一层字段之后、「恢复默认值」之前插一块自己的东西（扩展那块用它）。
  const layer = (title, note, fields, values, which, extra) => {
    const box = document.createElement('div')
    box.className = 'set-layer'
    box.innerHTML = '<div class="set-layer-title"></div><div class="set-layer-note"></div>'
    box.querySelector('.set-layer-title').textContent = title
    box.querySelector('.set-layer-note').textContent = note
    modal.body.append(box)

    const items = shownFields(fields)
    const common = items.filter((field) => field.tier !== 'advanced')
    const advanced = items.filter((field) => field.tier === 'advanced')

    const fill = (container, list) => {
      for (const field of list) {
        const spec = field.kind === 'shell' ? { ...field, options: shells } : field
        const row = fieldRow(modal, spec, values[field.key])
        container.append(row.wrap)
        readers.push({ field, layer: which, read: row.read, set: row.set })
        // 「启动时打开的工作文件夹」不在这一层里画，见 MACHINE_FIELDS 的 tier: 'hidden'
      }
    }

    for (const group of [...new Set(common.map((field) => field.group))]) {
      fill(groupBox(box, group), common.filter((field) => field.group === group))
    }

    if (advanced.length) {
      const more = document.createElement('details')
      more.className = 'set-more'
      const summary = document.createElement('summary')
      summary.textContent = `细节（${advanced.length} 项）`
      more.append(summary)
      const inner = document.createElement('div')
      inner.className = 'set-more-body'
      more.append(inner)
      box.append(more)
      for (const group of [...new Set(advanced.map((field) => field.group))]) {
        fill(groupBox(inner, group), advanced.filter((field) => field.group === group))
      }
    }

    if (extra) extra(box)

    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'set-restore'
    restore.textContent = '恢复这一层的默认值'
    restore.addEventListener('click', () => {
      for (const item of readers.filter((reader) => reader.layer === which)) item.set(item.field.def)
    })
    box.append(restore)
  }

  layer('跟这台机器走', '存在用户目录里，换工作文件夹不变；不进画布存档', MACHINE_FIELDS, current.machine, 'machine')
  layer('跟这份画布走', '进画布存档，换个工作文件夹打开就跟着变', CANVAS_FIELDS, current.canvas, 'canvas', (box) => {
    extensionImport(box, { hasWorkspace, onImported })
  })

  const submit = async () => {
    const next = { machine: {}, canvas: {} }
    for (const { field, layer: which, read } of readers) {
      const raw = read()
      if (field.kind === 'int' || field.kind === 'number') {
        if (!Number.isFinite(Number(raw))) {
          modal.error.textContent = `「${field.label}」得填一个数`
          return
        }
      }
      // 运行目录这类允许相对路径（“.” 就是工作文件夹），只有纯本机路径才必须绝对
      if (field.kind === 'path' && !field.allowRelative && raw && !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(raw)) {
        modal.error.textContent = `「${field.label}」要填本机绝对路径`
        return
      }
      next[which][field.key] = raw
    }
    modal.error.textContent = ''
    try {
      // 机器那一层交给后端存（它会把 cwd 这类规范成绝对路径）；画布那一层带回去由调用方收
      modal.finish({ machine: await request('/api/settings', next.machine), canvas: next.canvas })
    } catch (error) {
      modal.error.textContent = `保存失败：${error.message}`
    }
  }
  modal.ok.addEventListener('click', submit)
  return modal.promise
}
