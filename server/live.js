import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { EventEmitter } from 'node:events'
import { listTranscripts, extractPoints } from './transcripts.js'
import { embedOne, DIM } from './embed.js'
import { CLOUD_DIR, SIM_DIM } from './build.js'
import { scanProcesses } from './scan.js'

const POLL_MS = 1200
const PROC_MS = 4000

function readF32(file) {
  const b = fs.readFileSync(file)
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

/**
 * Watches the transcripts of running sessions and emits each new turn as it is
 * written, already projected into the same reduced space the indexed cloud
 * uses. This is what makes the view a picture of what the machine is doing now
 * rather than a picture of what it did.
 */
export class LiveTail extends EventEmitter {
  constructor() {
    super()
    this.offsets = new Map() // file -> bytes already consumed
    this.seq = new Map() // sessionId -> next point sequence
    this.started = false
    this.pca = null
  }

  loadProjection() {
    const meanFile = path.join(CLOUD_DIR, 'pca-mean.bin')
    if (!fs.existsSync(meanFile)) return null
    if (!this.pca) {
      this.pca = { mean: readF32(meanFile), comp: readF32(path.join(CLOUD_DIR, 'pca-comp.bin')) }
    }
    return this.pca
  }

  project(vec) {
    const p = this.loadProjection()
    if (!p) return null
    const out = new Float32Array(SIM_DIM)
    for (let d = 0; d < DIM; d++) {
      const v = vec[d] - p.mean[d]
      if (v === 0) continue
      for (let c = 0; c < SIM_DIM; c++) out[c] += v * p.comp[d * SIM_DIM + c]
    }
    let m = 0
    for (let c = 0; c < SIM_DIM; c++) m += out[c] ** 2
    m = Math.sqrt(m) || 1
    for (let c = 0; c < SIM_DIM; c++) out[c] /= m
    return out
  }

  start() {
    if (this.started) return this
    this.started = true
    // Everything already on disk is the indexed past; only tail what arrives
    // from here on.
    for (const t of listTranscripts()) this.offsets.set(t.file, t.size)
    this.pollTranscripts()
    this.pollProcesses()
    return this
  }

  stop() {
    clearTimeout(this._t1)
    clearTimeout(this._t2)
    this.started = false
  }

  async pollProcesses() {
    try {
      this.emit('processes', await scanProcesses())
    } catch {}
    this._t2 = setTimeout(() => this.pollProcesses(), PROC_MS)
  }

  async pollTranscripts() {
    try {
      for (const t of listTranscripts()) {
        const seen = this.offsets.get(t.file)
        if (seen === undefined) {
          // A session that started after we booted: take it whole.
          this.offsets.set(t.file, 0)
          await this.drain({ ...t, from: 0 })
        } else if (t.size > seen) {
          this.offsets.set(t.file, t.size)
          await this.drain({ ...t, from: seen })
        }
      }
    } catch (e) {
      this.emit('warn', e.message)
    }
    this._t1 = setTimeout(() => this.pollTranscripts(), POLL_MS)
  }

  async drain(t) {
    const lines = await readRange(t.file, t.from, t.size)
    const batch = []
    let cwd = t.projectPath
    let title = null
    for (const line of lines) {
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type === 'ai-title' && e.aiTitle) { title = e.aiTitle; continue }
      if (e.cwd) cwd = e.cwd
      if (e.type !== 'user' && e.type !== 'assistant') continue
      const start = this.seq.get(t.sessionId) ?? 0
      const pts = extractPoints(e, start)
      if (!pts.length) continue
      this.seq.set(t.sessionId, start + pts.length)
      batch.push(...pts)
    }
    if (!batch.length) return

    // Cap a single burst: a compaction or a huge tool result should not stall
    // the tail behind hundreds of embeddings.
    const use = batch.slice(-24)
    const out = []
    for (const p of use) {
      let sim = null
      try {
        sim = this.project(await embedOne(p.text))
      } catch {}
      if (!sim) continue
      out.push({
        kind: p.kind,
        tool: p.tool,
        t: p.t,
        len: p.len,
        error: p.error,
        snippet: p.snippet,
        sim: Array.from(sim),
      })
    }
    if (out.length)
      this.emit('points', { sessionId: t.sessionId, projectPath: cwd, title, points: out, dropped: batch.length - use.length })
  }
}

function readRange(file, from, to) {
  return new Promise((resolve, reject) => {
    const lines = []
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { start: from, end: Math.max(from, to - 1), encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    rl.on('line', (l) => { if (l.trim()) lines.push(l) })
    rl.on('close', () => resolve(lines))
    rl.on('error', reject)
  })
}
