import fs from 'node:fs'
import path from 'node:path'
import { listTranscripts, readTranscript } from './transcripts.js'
import { embedAll, CACHE_DIR, DIM } from './embed.js'
import { pca, layoutIslands } from './layout.js'

export const SIM_DIM = 64
const LABEL = 90
const OUT = path.join(CACHE_DIR, 'cloud')

const KINDS = ['user', 'assistant', 'thinking', 'tool', 'result']

/**
 * Builds the whole cloud: every transcript on the machine becomes an ordered
 * run of points, positioned by meaning rather than by file.
 */
export async function build(onProgress = () => {}) {
  const t0 = Date.now()
  const files = listTranscripts()
  const sessions = []
  const points = []
  const texts = []

  for (let i = 0; i < files.length; i++) {
    onProgress({ phase: 'read', done: i, total: files.length, label: files[i].sessionId })
    const { session, points: pts } = await readTranscript(files[i])
    if (!pts.length) continue
    const si = sessions.length
    sessions.push(session)
    for (const p of pts) {
      points.push({ s: si, ...p })
      texts.push(p.text)
    }
  }

  const n = points.length
  if (!n) throw new Error(`No conversation found under ${path.join(CACHE_DIR, '..')} — is ~/.claude/projects populated?`)

  const vecs = await embedAll(texts, onProgress)

  onProgress({ phase: 'reduce', done: 0, total: 3, label: 'pca' })
  const { proj, mean, components } = pca(vecs, n, DIM, SIM_DIM)

  // Unit-normalise the reduced vectors so the client can use a plain dot
  // product as cosine similarity when it re-weights the cloud.
  const sim = new Float32Array(n * SIM_DIM)
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let c = 0; c < SIM_DIM; c++) m += proj[i * SIM_DIM + c] ** 2
    m = Math.sqrt(m) || 1
    for (let c = 0; c < SIM_DIM; c++) sim[i * SIM_DIM + c] = proj[i * SIM_DIM + c] / m
  }

  onProgress({ phase: 'reduce', done: 1, total: 3, label: 'layout' })
  const sessionOf = new Int32Array(n)
  for (let i = 0; i < n; i++) sessionOf[i] = points[i].s
  const { pos, islands } = layoutIslands(proj, n, SIM_DIM, sessionOf, sessions.length)
  onProgress({ phase: 'reduce', done: 2, total: 3, label: 'columns' })

  // Compact, typed-array-friendly columns; the heavy snippet text is served
  // separately and only for the points the user actually inspects.
  const meta = {
    builtAt: Date.now(),
    buildMs: 0,
    count: n,
    simDim: SIM_DIM,
    kinds: KINDS,
    sessions: sessions.map((s, i) => ({
      i,
      sessionId: s.sessionId,
      title: s.title,
      project: s.project,
      projectPath: s.projectPath,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      start: s.start,
      end: s.end,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      cacheRead: s.cacheRead,
      userTurns: s.userTurns,
      assistantTurns: s.assistantTurns,
      toolCalls: s.toolCalls,
      errors: s.errors,
      models: Object.keys(s.models),
      points: s.points,
      isSidechainOnly: s.isSidechainOnly,
    })),
    tools: [],
    islands,
    labels: points.map((p) => p.text.slice(0, LABEL)),
  }

  const toolIndex = new Map()
  const cols = {
    session: new Int32Array(n),
    seq: new Int32Array(n),
    kind: new Uint8Array(n),
    time: new Float64Array(n),
    tool: new Int16Array(n),
    len: new Int32Array(n),
    flags: new Uint8Array(n),
  }
  for (let i = 0; i < n; i++) {
    const p = points[i]
    cols.session[i] = p.s
    cols.seq[i] = p.seq
    cols.kind[i] = KINDS.indexOf(p.kind)
    cols.time[i] = p.t || 0
    cols.len[i] = p.len
    cols.flags[i] = p.error
    if (p.tool) {
      if (!toolIndex.has(p.tool)) toolIndex.set(p.tool, toolIndex.size)
      cols.tool[i] = toolIndex.get(p.tool)
    } else cols.tool[i] = -1
  }
  meta.tools = [...toolIndex.keys()]
  meta.buildMs = Date.now() - t0

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta))
  fs.writeFileSync(path.join(OUT, 'pos.bin'), Buffer.from(pos.buffer))
  fs.writeFileSync(path.join(OUT, 'sim.bin'), Buffer.from(sim.buffer))
  for (const [name, arr] of Object.entries(cols))
    fs.writeFileSync(path.join(OUT, `${name}.bin`), Buffer.from(arr.buffer))
  // Keep the projection itself so a live search query can be mapped into the
  // same reduced space the client compares against.
  fs.writeFileSync(path.join(OUT, 'pca-mean.bin'), Buffer.from(mean.buffer))
  fs.writeFileSync(path.join(OUT, 'pca-comp.bin'), Buffer.from(components.buffer))
  fs.writeFileSync(
    path.join(OUT, 'snippets.json'),
    JSON.stringify(points.map((p) => p.snippet))
  )

  return { meta, dir: OUT }
}

export function loadBuilt() {
  const metaPath = path.join(OUT, 'meta.json')
  if (!fs.existsSync(metaPath)) return null
  return { meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir: OUT }
}

export { OUT as CLOUD_DIR }
