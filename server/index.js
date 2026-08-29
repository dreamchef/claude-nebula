import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadBuilt, CLOUD_DIR, SIM_DIM } from './build.js'
import { scanProcesses } from './scan.js'
import { embedOne, DIM } from './embed.js'
import { listTranscripts, readTranscript } from './transcripts.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 5174)

const app = express()
app.use(express.json({ limit: '1mb' }))

let building = null
let progress = null

app.get('/api/status', (req, res) => {
  const built = loadBuilt()
  res.json({
    building: !!building,
    progress,
    indexed: !!built,
    summary: built && {
      builtAt: built.meta.builtAt,
      count: built.meta.count,
      sessions: built.meta.sessions.length,
      buildMs: built.meta.buildMs,
    },
    transcripts: listTranscripts().length,
  })
})

app.post('/api/index', (req, res) => {
  if (!building) {
    progress = { phase: 'read', done: 0, total: 1 }
    building = build((p) => { progress = p })
      .then(() => { progress = { phase: 'done', done: 1, total: 1 } })
      .catch((e) => { progress = { phase: 'error', error: e.message, done: 0, total: 1 } })
      .finally(() => { building = null })
  }
  res.json({ started: true })
})

app.get('/api/cloud/:name', (req, res) => {
  const file = path.join(CLOUD_DIR, path.basename(req.params.name))
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not indexed' })
  res.type(file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-cache')
  fs.createReadStream(file).pipe(res)
})

app.get('/api/processes', async (req, res) => {
  res.json({ at: Date.now(), processes: await scanProcesses() })
})

/** Projects a free-text query into the reduced space the cloud is laid out in. */
app.post('/api/search', async (req, res) => {
  const q = String(req.body?.q || '').trim()
  if (!q) return res.status(400).json({ error: 'empty query' })
  const meanFile = path.join(CLOUD_DIR, 'pca-mean.bin')
  if (!fs.existsSync(meanFile)) return res.status(409).json({ error: 'not indexed' })
  try {
    const vec = await embedOne(q)
    const mean = new Float32Array(fs.readFileSync(meanFile).buffer)
    const comp = new Float32Array(fs.readFileSync(path.join(CLOUD_DIR, 'pca-comp.bin')).buffer)
    const out = new Float32Array(SIM_DIM)
    for (let d = 0; d < DIM; d++) {
      const v = vec[d] - mean[d]
      if (v === 0) continue
      for (let c = 0; c < SIM_DIM; c++) out[c] += v * comp[d * SIM_DIM + c]
    }
    let m = 0
    for (let c = 0; c < SIM_DIM; c++) m += out[c] ** 2
    m = Math.sqrt(m) || 1
    res.json({ q, vector: Array.from(out, (v) => v / m) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/** Full text of one session, for the detail pane. */
app.get('/api/session/:id', async (req, res) => {
  const t = listTranscripts().find((x) => x.sessionId === req.params.id)
  if (!t) return res.status(404).json({ error: 'no such session' })
  const { session, points } = await readTranscript(t)
  res.json({ session: { ...session, file: undefined }, points })
})

const dist = path.join(ROOT, 'dist')
if (fs.existsSync(dist)) app.use(express.static(dist))

app.listen(PORT, '127.0.0.1', () => {
  console.log(`nebula api  http://127.0.0.1:${PORT}`)
  if (!loadBuilt()) console.log('no index yet — run `npm run index` (or hit Build index in the UI)')
})
