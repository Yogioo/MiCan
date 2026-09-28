// 进化面板：浮在画布右边。上面是自动进化的开关和条件，中间是商量的对话（ADR-0028）：
// 点「开始商量」起一轮，之后可以接着说、「应用」（校验 + 一个 commit）或「放弃」（还原），下面还有进化记录（ADR-0024）。
// 再下面是过程（诊断、pi 每一轮、校验），每轮交给 pi 的提示词折叠在那一轮前面；点一条记录，下面换成那次的说明、改动的文件和过程。
// 开始商量时自己弹出来，点 × 才关。关掉时画布上「进化改过」的标记一并收掉，但那版改动留着。
import { renderMarkdown } from './markdown.mjs'
import { isActLine } from './nodes.mjs'
import { request } from './workspace-dialog.mjs'

// 过程里的 {"prompt":N}：第 N 份提示词插在这儿
const promptAt = (row) => Number(row.trim().match(/^\{"prompt":(\d+)\}$/)?.[1]) || 0

const BY = { manual: '手动', runs: '攒够运行', streak: '连败', daily: '每天定时', undo: '撤销' }

const when = (at) => {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function mountEvolveWindow({ getState, actions, onClose }) {
  const el = document.createElement('div')
  el.id = 'evolve-window'
  el.hidden = true
  el.innerHTML =
    '<div class="evolve-head"><span class="evolve-title">进化</span><span class="evolve-phase"></span>' +
    '<button type="button" class="evolve-close" title="关掉窗口，收掉画布上的标记">×</button></div>' +
    '<div class="evolve-panel">' +
    '<div class="evolve-auto">' +
    '<label><input type="checkbox" class="evolve-on"> 自动进化</label>' +
    '<label>攒够 <input type="number" min="1" class="evolve-runs"> 次运行</label>' +
    '<label>连败 <input type="number" min="1" class="evolve-streak"> 次</label>' +
    '<label>每天 <input type="time" class="evolve-daily"></label>' +
    '</div>' +
    '<div class="evolve-note">上次进化之后，哪项满足就进化；空着的不看。有链在跑就等它跑完。</div>' +
    '<div class="evolve-talk" hidden>' +
    '<div class="evolve-files"></div>' +
    '<div class="evolve-turns"></div>' +
    '<div class="evolve-actions"><button type="button" class="evolve-apply primary">应用</button><button type="button" class="evolve-discard">放弃</button><span class="evolve-said">「应用」才进 git；「放弃」整份还原到这次商量之前</span></div>' +
    '</div>' +
    '<textarea class="evolve-hint" spellcheck="false" placeholder="进化提示词：遇到的问题（如「提取老漏掉附件」）；空着就只照运行历史的诊断改"></textarea>' +
    '<div class="evolve-actions"><span class="evolve-error"></span><button type="button" class="evolve-now primary">开始商量</button></div>' +
    '<div class="evolve-records"></div>' +
    '</div>' +
    '<div class="evolve-log"></div>'
  document.body.append(el)
  const $ = (selector) => el.querySelector(selector)
  const phase = $('.evolve-phase')
  const body = $('.evolve-log')
  const error = $('.evolve-error')
  const hint = $('.evolve-hint')
  const records = $('.evolve-records')
  const talkBox = $('.evolve-talk')
  const filesLine = $('.evolve-files')
  const turnsBox = $('.evolve-turns')
  const nowButton = $('.evolve-now')
  const fields = { auto: $('.evolve-on'), runs: $('.evolve-runs'), streak: $('.evolve-streak'), daily: $('.evolve-daily') }
  let items = []
  // 商量（ADR-0028）：对话在盘上有一份新的就重读
  let turns = []
  let shownTurns = -1
  let talking = false

  $('.evolve-close').addEventListener('click', () => {
    el.hidden = true
    onClose()
  })
  // 没在商量时是「开始商量」（带上进化提示词），商量开着时是「发送」（这一轮说的话）
  nowButton.addEventListener('click', () => {
    const text = hint.value.trim()
    if (talking) {
      actions.say(text)
      hint.value = ''
      return
    }
    actions.evolve(text)
  })
  $('.evolve-apply').addEventListener('click', () => actions.apply())
  $('.evolve-discard').addEventListener('click', () => actions.discard())

  // 改一项就整份写回；后端不认的值报在按钮旁边，框里的字不动
  async function saveConfig() {
    const config = {
      auto: fields.auto.checked,
      runs: fields.runs.value,
      streak: fields.streak.value,
      daily: fields.daily.value,
    }
    try {
      await request('/api/evolve/config', { config })
      error.textContent = ''
    } catch (failure) {
      error.textContent = failure.message
    }
  }
  for (const input of Object.values(fields)) input.addEventListener('change', saveConfig)

  // 动作行是给诊断扩展读的，不铺出来；块边界可能切在一行中间，攒到换行再判
  let pending = ''
  let prompts = []
  let tail = null // 最后那段纯文字：新来的字接在它后面，遇到提示词另起一段

  function reset() {
    pending = ''
    prompts = []
    tail = null
    body.textContent = ''
  }

  function write(text) {
    if (!tail) {
      tail = document.createElement('pre')
      body.append(tail)
    }
    tail.textContent += text
  }

  function addPrompt(n) {
    const box = document.createElement('details')
    box.className = 'evolve-prompt'
    const title = document.createElement('summary')
    title.textContent = `第 ${n} 轮交给 pi 的提示词`
    const text = document.createElement('div')
    text.className = 'md'
    text.innerHTML = renderMarkdown(prompts[n - 1] ?? '')
    box.append(title, text)
    body.append(box)
    tail = null
  }

  function append(text, more = []) {
    prompts.push(...more)
    if (!text) return
    const rows = `${pending}${text}`.split('\n')
    pending = rows.pop()
    // 看着底部时跟着滚；往上翻了就别拽回去
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
    let run = []
    for (const row of rows) {
      if (isActLine(row)) continue
      const n = promptAt(row)
      if (!n) {
        run.push(row)
        continue
      }
      if (run.length) write(`${run.join('\n')}\n`)
      run = []
      addPrompt(n)
    }
    if (run.length) write(`${run.join('\n')}\n`)
    if (atBottom) body.scrollTop = body.scrollHeight
  }

  async function showRecord(entry) {
    if (getState().evolve?.active) return // 下面正滚着这次的过程
    let detail
    try {
      detail = await request('/api/evolve/record', { at: entry.at })
    } catch (failure) {
      error.textContent = failure.message
      return
    }
    reset()
    const given = detail.prompts ?? []
    // 以前的过程里没有提示词的标记：放在过程前面
    const marks = detail.log.split('\n').some((row) => promptAt(row)) ? '' : given.map((_, i) => `{"prompt":${i + 1}}\n`).join('')
    append(`${detail.show || entry.message}\n\n${marks}── 过程 ──\n${detail.log}\n`, given)
    body.scrollTop = 0
  }

  function renderRecords() {
    records.textContent = ''
    if (!items.length) {
      records.textContent = '还没有进化记录'
      return
    }
    const busy = Boolean(getState().evolve?.active)
    for (const entry of [...items].reverse()) {
      const row = document.createElement('div')
      row.className = `evolve-record${entry.ok ? '' : ' failed'}`
      const text = document.createElement('span')
      text.className = 'evolve-record-text'
      text.textContent = `${when(entry.at)} · ${BY[entry.by] ?? entry.by} · ${String(entry.message ?? '').split('\n')[0]}`
      text.title = entry.hint ? `${entry.by === 'undo' ? '撤销理由' : '进化提示词'}：${entry.hint}` : ''
      text.addEventListener('click', () => showRecord(entry))
      row.append(text)
      if (entry.commit) {
        const undo = document.createElement('button')
        undo.type = 'button'
        undo.textContent = '撤销'
        undo.disabled = busy
        undo.addEventListener('click', () => actions.undo(entry))
        row.append(undo)
      }
      // 这一次单独撤过、没撤成：给整份还原的退路
      const stuck = items.some((item) => item.at > entry.at && item.stuck && item.target === entry.commit)
      if (entry.commit && entry.snapshot && stuck) {
        const back = document.createElement('button')
        back.type = 'button'
        back.textContent = '还原到这次之前'
        back.disabled = busy
        back.addEventListener('click', () => actions.restore(entry, items.filter((item) => item.commit && item.at > entry.at)))
        row.append(back)
      }
      records.append(row)
    }
  }

  // 配置和记录跟工作文件夹走：打开面板、换文件夹、进化做完都重读一遍
  async function refresh() {
    if (el.hidden || !getState().workspace) return
    try {
      const [config, history] = await Promise.all([request('/api/evolve/config', {}), request('/api/evolve/history', {})])
      fields.auto.checked = config.auto === true
      fields.runs.value = config.runs ?? ''
      fields.streak.value = config.streak ?? ''
      fields.daily.value = config.daily ?? ''
      items = history.items ?? []
      error.textContent = ''
    } catch (failure) {
      error.textContent = failure.message
    }
    renderRecords()
  }

  function open() {
    const wasHidden = el.hidden
    el.hidden = false
    if (wasHidden) refresh()
  }

  function toggle() {
    if (el.hidden) return open()
    el.hidden = true
    onClose()
  }

  // 你说一句、pi 回一句，按这个顺序铺；过程还在下面那半部分
  function renderTurns() {
    turnsBox.textContent = ''
    for (const row of turns) {
      const box = document.createElement('div')
      box.className = `evolve-turn ${row.role === 'user' ? 'user' : 'agent'}${row.ok === false ? ' failed' : ''}`
      box.textContent = String(row.text ?? '')
      turnsBox.append(box)
    }
    turnsBox.scrollTop = turnsBox.scrollHeight
  }

  async function loadTalk() {
    try {
      const talk = await request('/api/evolve/talk', {})
      turns = talk.turns ?? []
      shownTurns = turns.length
      renderTurns()
    } catch (failure) {
      error.textContent = failure.message
    }
  }

  const filesText = (files) => (files?.length ? `已改 ${files.length} 个文件，还没应用：${files.join('、')}` : '还没改盘上的东西')

  let wasBusy = false
  function render(state) {
    const evolve = state.evolve
    const talk = evolve?.talk ?? null
    const running = Boolean(evolve?.running)
    const busy = Boolean(evolve?.active)
    talking = Boolean(talk)
    phase.textContent = busy ? evolve.phase || '…' : evolve?.last ? (evolve.last.ok ? '做完了' : '没做成') : ''
    el.classList.toggle('done', Boolean(evolve && !busy))
    el.classList.toggle('talking', talking)
    talkBox.hidden = !talking
    nowButton.textContent = talking ? '发送' : '开始商量'
    hint.placeholder = talking
      ? '接着说：哪儿不对、想改成什么样'
      : '进化提示词：遇到的问题（如「提取老漏掉附件」）；空着就只照运行历史的诊断改'
    // 商量开着时整个工作文件夹只读（ADR-0028）：配置和记录都锁着，只有「应用」「放弃」和接着说能点
    for (const input of Object.values(fields)) input.disabled = busy || !state.workspace
    hint.disabled = running || (!talking && busy) || !state.workspace
    nowButton.disabled = running || (!talking && busy) || !state.workspace
    $('.evolve-apply').disabled = running || !talking
    $('.evolve-discard').disabled = running || !talking
    if (talking) {
      filesLine.textContent = filesText(talk.files)
      // 对话在盘上多了一份新的（pi 刚说完、面板刚打开）就读回来
      if (talk.turns !== shownTurns) {
        shownTurns = talk.turns
        loadTalk()
      }
    } else if (shownTurns !== -1) {
      shownTurns = -1
      turns = []
      turnsBox.textContent = ''
      filesLine.textContent = ''
    }
    if (busy !== wasBusy) renderRecords()
    wasBusy = busy
  }

  return { open, toggle, reset, append, render, refresh }
}
