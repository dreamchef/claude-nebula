/**
 * Streams new conversation turns into the cloud as they are written.
 *
 * A turn lands inside its own conversation's island — never blended into a
 * neighbour's — placed next to whichever of that conversation's existing turns
 * it is closest to in meaning.
 */
const GOLDEN = 2.399963229728653

export class LiveFeed {
  constructor(store, handlers) {
    this.store = store
    this.h = handlers
    this.activity = new Map() // sessionId -> last turn seen
  }

  connect() {
    const es = new EventSource('/api/live')
    es.addEventListener('processes', (e) => {
      const { processes } = JSON.parse(e.data)
      this.store.setProcesses(processes)
      this.h.onProcesses(processes, this.activity)
    })
    es.addEventListener('points', (e) => {
      const msg = JSON.parse(e.data)
      const last = msg.points[msg.points.length - 1]
      this.activity.set(msg.sessionId, { ...last, at: Date.now(), dropped: msg.dropped })
      const added = this.store.append(msg)
      this.h.onPoints(msg, added, this.activity)
    })
    es.onerror = () => this.h.onDisconnect?.()
    this.es = es
    return this
  }
}

/**
 * Owns the point arrays. Everything is allocated with spare capacity up front
 * so arriving turns are a write into existing buffers rather than a rebuild.
 */
export class PointStore {
  constructor(meta, cols, arrays, sim, count, capacity) {
    this.meta = meta
    this.cols = cols
    this.a = arrays
    this.sim = sim
    this.count = count
    this.capacity = capacity
    this.simDim = meta.simDim
    this.liveSessions = new Set()

    this.island = new Map()
    for (const is of meta.islands || []) this.island.set(is.session, is)

    this.bySession = new Map()
    for (let i = 0; i < count; i++) {
      const s = cols.session[i]
      if (!this.bySession.has(s)) this.bySession.set(s, [])
      this.bySession.get(s).push(i)
    }
    this.indexOfSession = new Map(meta.sessions.map((s) => [s.sessionId, s.i]))
  }

  setProcesses(processes) {
    const live = new Set()
    for (const p of processes) if (p.role === 'session' && p.sessionId) live.add(p.sessionId)
    this.liveSessions = live
    const flag = this.a.aLive.array
    for (let i = 0; i < this.count; i++) {
      const s = this.meta.sessions[this.cols.session[i]]
      flag[i] = s && live.has(s.sessionId) ? 1 : 0
    }
    this.dirty = true
  }

  /** Allocates an island for a conversation that began after the last index. */
  newSession(sessionId, projectPath, title) {
    const i = this.meta.sessions.length
    const rec = {
      i,
      sessionId,
      title: title || null,
      project: projectPath,
      projectPath,
      cwd: projectPath,
      start: Date.now(),
      end: Date.now(),
      tokensIn: 0, tokensOut: 0, cacheRead: 0,
      userTurns: 0, assistantTurns: 0, toolCalls: 0, errors: 0,
      models: [], points: 0, fresh: true,
    }
    this.meta.sessions.push(rec)
    this.indexOfSession.set(sessionId, i)
    this.bySession.set(i, [])

    // A conversation with no indexed history gets its own berth on the outer
    // shell rather than being dropped at the origin on top of everything else.
    const a = i * GOLDEN
    const r = 62
    this.island.set(i, {
      session: i,
      center: [Math.cos(a) * r, ((i % 7) - 3) * 7, Math.sin(a) * r],
      radius: 5,
      grown: true,
    })
    return rec
  }

  /** Position for a new turn: inside its island, beside its nearest sibling. */
  place(sessionIdx, sim) {
    const island = this.island.get(sessionIdx)
    const siblings = this.bySession.get(sessionIdx) || []
    const { simDim } = this
    const out = [0, 0, 0]

    if (siblings.length) {
      let best = -1, bestDot = -2
      for (const j of siblings) {
        let d = 0
        const jo = j * simDim
        for (let c = 0; c < simDim; c++) d += this.sim[jo + c] * sim[c]
        if (d > bestDot) { bestDot = d; best = j }
      }
      const pos = this.a.position.array
      const spread = Math.max(0.8, (island?.radius || 6) * 0.13)
      for (let d = 0; d < 3; d++) out[d] = pos[best * 3 + d] + (Math.random() - 0.5) * spread
      // Keep it inside its own island; a turn must never drift into a neighbour.
      if (island) {
        let dx = out[0] - island.center[0], dy = out[1] - island.center[1], dz = out[2] - island.center[2]
        const dist = Math.hypot(dx, dy, dz)
        const lim = island.radius * 1.06
        if (dist > lim) {
          const k = lim / dist
          out[0] = island.center[0] + dx * k
          out[1] = island.center[1] + dy * k
          out[2] = island.center[2] + dz * k
        }
      }
    } else if (island) {
      for (let d = 0; d < 3; d++) out[d] = island.center[d] + (Math.random() - 0.5) * 2
    }
    return out
  }

  append(msg) {
    let idx = this.indexOfSession.get(msg.sessionId)
    if (idx === undefined) idx = this.newSession(msg.sessionId, msg.projectPath, msg.title).i
    const session = this.meta.sessions[idx]
    if (msg.title && !session.title) session.title = msg.title

    const added = []
    const now = Date.now() / 1000
    for (const p of msg.points) {
      if (this.count >= this.capacity) break
      const i = this.count++
      const sim = p.sim

      for (let c = 0; c < this.simDim; c++) this.sim[i * this.simDim + c] = sim[c]
      const at = this.place(idx, sim)
      for (let d = 0; d < 3; d++) {
        this.a.position.array[i * 3 + d] = at[d]
        // In the time and project arrangements a new turn simply continues its
        // conversation's existing run.
        const prev = (this.bySession.get(idx) || []).slice(-1)[0]
        this.a.aPosTime.array[i * 3 + d] =
          prev !== undefined ? this.a.aPosTime.array[prev * 3 + d] + (Math.random() - 0.5) * 0.7 : at[d]
        this.a.aPosProj.array[i * 3 + d] =
          prev !== undefined ? this.a.aPosProj.array[prev * 3 + d] + (Math.random() - 0.5) * 0.7 : at[d]
      }

      this.cols.session[i] = idx
      this.cols.kind[i] = Math.max(0, this.meta.kinds.indexOf(p.kind))
      this.cols.time[i] = p.t || Date.now()
      this.cols.len[i] = p.len
      this.cols.flags[i] = p.error
      let ti = p.tool ? this.meta.tools.indexOf(p.tool) : -1
      if (p.tool && ti < 0) { this.meta.tools.push(p.tool); ti = this.meta.tools.length - 1 }
      this.cols.tool[i] = ti

      this.a.aKind.array[i] = this.cols.kind[i]
      this.a.aHue.array[i] = ((idx * 0.61803398875) % 1 + 1) % 1
      this.a.aAge.array[i] = 1
      this.a.aWeight.array[i] = Math.min(1, Math.log2(p.len + 2) / 14)
      this.a.aSession.array[i] = idx
      this.a.aBorn.array[i] = now
      this.a.aLive.array[i] = 1

      this.meta.labels[i] = p.snippet.slice(0, 90)
      if (this.snippets) this.snippets[i] = p.snippet

      this.bySession.get(idx).push(i)
      session.points++
      added.push(i)
    }

    // A conversation that keeps going needs room for its later turns.
    const island = this.island.get(idx)
    if (island && island.grown) island.radius = 2.2 + 2.3 * Math.sqrt(session.points)
    this.liveSessions.add(msg.sessionId)
    return added
  }
}
