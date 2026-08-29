const $ = (id) => document.getElementById(id)
const KIND_NAMES = ['user', 'assistant', 'thinking', 'tool', 'result']

const num = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(v))
const ago = (ms) => {
  if (!ms) return '—'
  const s = (Date.now() - ms) / 1000
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
const dur = (s) => (s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`)
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])

export class UI {
  constructor(state) {
    this.state = state
    this.cx = 0
    this.cy = 0
  }

  bootMessage(msg, frac) {
    $('boot-msg').textContent = msg
    $('boot-bar').style.width = `${Math.round((frac || 0) * 100)}%`
  }

  bootPrompt(transcripts, onBuild) {
    this.bootMessage(`found ${transcripts} transcripts — not indexed yet`, 0)
    const b = $('boot-build')
    b.hidden = false
    b.onclick = () => { b.hidden = true; onBuild() }
  }

  bind(handlers) {
    this.h = handlers

    const q = $('q')
    let t
    q.addEventListener('input', () => {
      $('q-clear').hidden = !q.value
      clearTimeout(t)
      t = setTimeout(() => this.h.onQuery(q.value.trim()), 260)
    })
    $('q-clear').onclick = () => { q.value = ''; $('q-clear').hidden = true; this.h.onQuery('') }

    for (const b of document.querySelectorAll('[data-layout]')) {
      b.onclick = () => {
        this.state.layout = Number(b.dataset.layout)
        for (const o of document.querySelectorAll('[data-layout]')) o.classList.toggle('on', o === b)
      }
    }
    for (const b of document.querySelectorAll('[data-color]')) {
      b.onclick = () => {
        this.state.colorMode = Number(b.dataset.color)
        for (const o of document.querySelectorAll('[data-color]')) o.classList.toggle('on', o === b)
      }
    }
    $('lens').oninput = (e) => { this.h.cloud.uniforms.uLensStrength.value = Number(e.target.value) }
    $('radius').oninput = (e) => { this.h.cloud.uniforms.uLensRadius.value = Number(e.target.value) }
    $('adaptive').onchange = (e) => { this.state.adaptive = e.target.checked }
    $('follow').onchange = (e) => { this.state.followLive = e.target.checked }
    $('liveonly').onchange = (e) => { this.state.liveOnly = e.target.checked }
    $('detail-close').onclick = () => this.closeDetail()

    $('legend').innerHTML = KIND_NAMES.map(
      (k, i) => `<span><i style="background:rgb(${this.h.KIND_COLORS[i].map((c) => Math.round(c * 255)).join(',')})"></i>${k}</span>`
    ).join('')
  }

  ready(meta) {
    $('boot').hidden = true
    for (const id of ['hud-top', 'procs', 'controls']) $(id).hidden = false
    const tokens = meta.sessions.reduce((t, s) => t + s.tokensIn + s.tokensOut, 0)
    $('stats').innerHTML =
      `<b>${num(meta.count)}</b> points · <b>${meta.sessions.length}</b> sessions · ` +
      `<b>${new Set(meta.sessions.map((s) => s.projectPath)).size}</b> projects · <b>${num(tokens)}</b> tokens`
  }

  cursor(x, y) {
    this.cx = x
    this.cy = y
    const tip = $('tip')
    if (tip.hidden) return
    tip.style.left = `${Math.min(x + 16, innerWidth - tip.offsetWidth - 12)}px`
    tip.style.top = `${Math.min(y + 16, innerHeight - tip.offsetHeight - 12)}px`
  }

  hover(i) {
    const tip = $('tip')
    if (i < 0) { tip.hidden = true; return }
    const { cols, meta, snippets } = this.state
    const s = meta.sessions[cols.session[i]]
    const kind = KIND_NAMES[cols.kind[i]]
    const tool = cols.tool[i] >= 0 ? meta.tools[cols.tool[i]] : null
    tip.innerHTML =
      `<div class="head">${esc(kind)}${tool ? ` · ${esc(tool)}` : ''}</div>` +
      `<div class="sub">${esc(s.title || s.sessionId.slice(0, 8))} · ${esc(s.projectPath.split('/').pop())} · ${ago(cols.time[i])}</div>` +
      `<div>${esc((snippets ? snippets[i] : meta.labels[i]).slice(0, 260))}…</div>`
    tip.hidden = false
    this.cursor(this.cx, this.cy)
  }

  detail(i, near) {
    const { cols, meta, snippets } = this.state
    const s = meta.sessions[cols.session[i]]
    const tool = cols.tool[i] >= 0 ? meta.tools[cols.tool[i]] : null
    $('detail-body').innerHTML =
      `<h3>${esc(s.title || 'untitled session')}</h3>` +
      `<div class="meta">${esc(s.projectPath)}${s.gitBranch ? ` · ${esc(s.gitBranch)}` : ''}</div>` +
      `<div class="kv">
        <span>kind</span><span>${esc(KIND_NAMES[cols.kind[i]])}${tool ? ` · ${esc(tool)}` : ''}</span>
        <span>when</span><span>${ago(cols.time[i])}</span>
        <span>session</span><span>${esc(s.sessionId)}</span>
        <span>turns</span><span>${s.userTurns} user / ${s.assistantTurns} assistant</span>
        <span>tools</span><span>${s.toolCalls}${s.errors ? ` · ${s.errors} errors` : ''}</span>
        <span>tokens</span><span>${num(s.tokensIn)} in / ${num(s.tokensOut)} out · ${num(s.cacheRead)} cached</span>
        <span>models</span><span>${esc(s.models.join(', ') || '—')}</span>
      </div>` +
      `<pre>${esc(snippets ? snippets[i] : meta.labels[i])}</pre>` +
      `<div class="near"><h2>nearest in meaning</h2>${near
        .map((j) => `<div data-i="${j}">${esc((snippets ? snippets[j] : meta.labels[j]).slice(0, 110))}…</div>`)
        .join('')}</div>`
    for (const el of $('detail-body').querySelectorAll('[data-i]'))
      el.onclick = () => this.h.onFocusPoint(Number(el.dataset.i))
    $('detail').hidden = false
  }

  closeDetail() { $('detail').hidden = true }

  showMatches(idx) {
    if (!idx.length) return
    const { cols, meta, snippets } = this.state
    $('detail-body').innerHTML =
      `<h3>closest to your query</h3><div class="near">${idx
        .map((j) => {
          const s = meta.sessions[cols.session[j]]
          return `<div data-i="${j}"><b>${esc(s.projectPath.split('/').pop())}</b> · ${esc(
            (snippets ? snippets[j] : meta.labels[j]).slice(0, 110)
          )}…</div>`
        })
        .join('')}</div>`
    for (const el of $('detail-body').querySelectorAll('[data-i]'))
      el.onclick = () => this.h.onFocusPoint(Number(el.dataset.i))
    $('detail').hidden = false
  }

  /** Floating markers over the conversations that are running right now. */
  labels(items) {
    const host = $('labels')
    const html = items
      .map(
        (l) => `<div class="lab" style="left:${l.x.toFixed(0)}px;top:${l.y.toFixed(0)}px">
          <div class="ring ${l.busy ? 'busy' : ''}"></div>
          <div class="name">${esc(l.name)}</div>
          <div class="act">${esc(l.act || '')}</div>
        </div>`
      )
      .join('')
    if (html !== this._labelHtml) {
      host.innerHTML = html
      this._labelHtml = html
    }
  }

  liveState(connected) {
    $('live-dot').classList.toggle('live', connected !== false)
  }

  /** One turn just landed: refresh the row for that conversation immediately. */
  activity(msg, activity) {
    this.liveState(true)
    this._activity = activity
    if (this._procs) this.processes(this._procs, activity)
  }

  processes(list, activity = this._activity || new Map()) {
    this._procs = list
    this._activity = activity
    const sessions = list.filter((p) => p.role === 'session')
    const support = list.filter((p) => p.role !== 'session')

    const rows = sessions
      .sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0))
      .map((p) => {
        const act = p.sessionId ? activity.get(p.sessionId) : null
        const what = act
          ? `<div class="doing"><b>${esc(act.tool || KIND_NAMES[['user','assistant','thinking','tool','result'].indexOf(act.kind)] || act.kind)}</b> ${esc(
              act.snippet.slice(0, 120)
            )}…</div>`
          : '<div class="meta idle">no new turns since you opened this</div>'
        return `<li class="${p.sessionId ? 'linked' : ''}" data-sid="${p.sessionId || ''}">
          <span class="dot ${p.live ? 'live' : ''}"></span><span class="pid">${p.pid}</span>
          ${esc((p.cwd || '?').split('/').pop())}
          ${what}
          <div class="meta">up ${dur(p.uptimeSec)} · ${num(Math.round(p.rssKb / 1024))}MB${
            act ? ` · ${ago(act.at)}` : ''
          }</div>
        </li>`
      })

    if (support.length) {
      const by = support.reduce((m, p) => ((m[p.role] = (m[p.role] || 0) + 1), m), {})
      rows.push(`<li><div class="meta">${Object.entries(by).map(([k, v]) => `${v}× ${k}`).join(' · ')}</div></li>`)
    }
    $('proc-list').innerHTML = rows.join('') || '<li class="meta">no claude sessions running</li>'
    for (const el of $('proc-list').querySelectorAll('[data-sid]'))
      if (el.dataset.sid) el.onclick = () => this.h.onSelectSession(el.dataset.sid)
  }
}
