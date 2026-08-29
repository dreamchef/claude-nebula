import * as THREE from 'three'
import { Cloud, KIND_COLORS } from './cloud.js'
import { timeLayout, projectLayout, threadSegments } from './layouts.js'
import { UI } from './ui.js'
import { LiveFeed, PointStore } from './live.js'

const SPARE = 24000 // room for live turns to land in

const api = (p, opt) => fetch(`/api${p}`, opt)
const bin = async (name, Type) => new Type(await (await api(`/cloud/${name}`)).arrayBuffer())

const state = {
  meta: null,
  cols: null,
  sim: null,
  simDim: 64,
  snippets: null,
  hover: -1,
  pinned: -1,
  layout: 0,
  colorMode: 0,
  adaptive: true,
  relActive: 0,
  relTarget: 0,
  query: null,
  selSession: -1,
  lastUserZoom: 0,
  followLive: true,
  liveOnly: false,
  store: null,
}

const ui = new UI(state)
const cloud = new Cloud(document.getElementById('stage'))

// Handy from the console when tuning the view.
window.__nebula = { state, cloud, frame }

/* ---------- boot ---------- */

async function boot() {
  const st = await (await api('/status')).json()
  if (!st.indexed) {
    if (st.building) return followBuild()
    ui.bootPrompt(st.transcripts, () => {
      api('/index', { method: 'POST' })
      followBuild()
    })
    return
  }
  await load()
}

async function followBuild() {
  ui.bootMessage('indexing…', 0)
  const tick = async () => {
    const st = await (await api('/status')).json()
    const p = st.progress
    if (p) {
      if (p.phase === 'error') return ui.bootMessage(`failed: ${p.error}`, 0)
      ui.bootMessage(`${p.phase}${p.label ? ` · ${p.label}` : ''}`, p.total ? p.done / p.total : 0)
    }
    if (st.indexed && !st.building) return load()
    setTimeout(tick, 700)
  }
  tick()
}

async function load() {
  ui.bootMessage('loading cloud…', 0.1)
  const meta = await (await api('/cloud/meta.json')).json()
  state.meta = meta
  state.simDim = meta.simDim

  const [pos, sim, session, seq, kind, time, tool, len, flags] = await Promise.all([
    bin('pos.bin', Float32Array),
    bin('sim.bin', Float32Array),
    bin('session.bin', Int32Array),
    bin('seq.bin', Int32Array),
    bin('kind.bin', Uint8Array),
    bin('time.bin', Float64Array),
    bin('tool.bin', Int16Array),
    bin('len.bin', Int32Array),
    bin('flags.bin', Uint8Array),
  ])

  ui.bootMessage('arranging…', 0.6)
  const n = kind.length
  const cap = n + SPARE

  // Everything is over-allocated so live turns append in place.
  const grow = (Type, src, stride = 1) => {
    const a = new Type(cap * stride)
    a.set(src.subarray ? src.subarray(0, n * stride) : src)
    return a
  }
  const cols = {
    session: grow(Int32Array, session),
    seq: grow(Int32Array, seq),
    kind: grow(Uint8Array, kind),
    time: grow(Float64Array, time),
    tool: grow(Int16Array, tool),
    len: grow(Int32Array, len),
    flags: grow(Uint8Array, flags),
  }
  state.cols = cols

  const posTime = timeLayout(meta, { session, kind })
  const posProj = projectLayout(meta, { session, kind })

  let tmin = Infinity, tmax = -Infinity
  for (let i = 0; i < n; i++) {
    const t = time[i]
    if (!t) continue
    if (t < tmin) tmin = t
    if (t > tmax) tmax = t
  }
  const span = Math.max(1, tmax - tmin)

  const arrays = {
    position: { array: grow(Float32Array, pos, 3), size: 3 },
    aPosTime: { array: grow(Float32Array, posTime, 3), size: 3 },
    aPosProj: { array: grow(Float32Array, posProj, 3), size: 3 },
    aKind: { array: new Float32Array(cap), size: 1 },
    aHue: { array: new Float32Array(cap), size: 1 },
    aAge: { array: new Float32Array(cap), size: 1 },
    aWeight: { array: new Float32Array(cap), size: 1 },
    aSession: { array: new Float32Array(cap), size: 1 },
    aBorn: { array: new Float32Array(cap), size: 1 },
    aLive: { array: new Float32Array(cap), size: 1 },
  }
  for (let i = 0; i < n; i++) {
    arrays.aKind.array[i] = kind[i]
    arrays.aHue.array[i] = ((session[i] * 0.61803398875) % 1 + 1) % 1
    arrays.aAge.array[i] = time[i] ? (time[i] - tmin) / span : 0
    arrays.aWeight.array[i] = Math.min(1, Math.log2(len[i] + 2) / 14)
    arrays.aSession.array[i] = session[i]
  }

  state.sim = grow(Float32Array, sim, meta.simDim)

  cloud.setData(arrays, n, cap)
  cloud.setThreads(threadSegments(pos, { session }))
  state.arrays = arrays
  state.layouts = [arrays.position.array, arrays.aPosTime.array, arrays.aPosProj.array]

  state.store = new PointStore(meta, cols, arrays, state.sim, n, cap)
  ui.ready(meta)
  animate()

  api('/cloud/snippets.json').then((r) => r.json()).then((sn) => {
    sn.length = Math.max(sn.length, n)
    state.snippets = sn
    state.store.snippets = sn
  })

  new LiveFeed(state.store, {
    onProcesses: (procs, activity) => {
      state.liveActivity = activity
      ui.processes(procs, activity)
      cloud.grow(state.store.count)
      frameLive()
    },
    onPoints: (msg, added, activity) => {
      cloud.grow(state.store.count)
      state.liveActivity = activity
      ui.activity(msg, activity)
      updateLabels(true)
      if (state.followLive && added.length) {
        worldPos(added[added.length - 1], _v)
        state.flyTo = _v.clone()
      }
    },
    onDisconnect: () => ui.liveState(false),
  }).connect()
}

/* ---------- cursor focus ---------- */

const mouse = new THREE.Vector2(-2, -2)
let mouseMovedAt = 0
let dwellAt = 0

addEventListener('pointermove', (e) => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1
  mouse.y = -(e.clientY / innerHeight) * 2 + 1
  ui.cursor(e.clientX, e.clientY)
  mouseMovedAt = performance.now()
})
addEventListener('wheel', () => { state.lastUserZoom = performance.now() }, { passive: true })
document.getElementById('stage').addEventListener('pointerdown', () => { state.downAt = performance.now() })
document.getElementById('stage').addEventListener('pointerup', (e) => {
  if (performance.now() - (state.downAt || 0) > 240) return // a drag, not a pick
  if (state.hover >= 0) pin(state.hover)
  else { state.pinned = -1; state.selSession = -1; ui.closeDetail() }
})

const _v = new THREE.Vector3()
const HOME = new THREE.Vector3(0, 0, 0)
const weights = new THREE.Vector3(1, 0, 0)
const targetWeights = new THREE.Vector3(1, 0, 0)

/** Mirrors the vertex shader so screen-space picking hits what is actually drawn. */
function worldPos(i, out) {
  const [a, b, c] = state.layouts
  const o = i * 3
  let x = a[o] * weights.x + b[o] * weights.y + c[o] * weights.z
  let y = a[o + 1] * weights.x + b[o + 1] * weights.y + c[o + 1] * weights.z
  let z = a[o + 2] * weights.x + b[o + 2] * weights.y + c[o + 2] * weights.z

  const f = cloud.uniforms
  const rel = cloud.rel[i]
  const s = smoothstep(0.3, 0.92, rel) * f.uRelPull.value * f.uRelActive.value * 0.22
  const fx = f.uFocus.value
  x += (fx.x - x) * s; y += (fx.y - y) * s; z += (fx.z - z) * s

  let dx = x - fx.x, dy = y - fx.y, dz = z - fx.z
  const r = f.uLensRadius.value
  const dist = Math.hypot(dx, dy, dz) || 1e-4
  const g = Math.exp(-(dist * dist) / Math.max(r * r, 0.001)) * f.uLensStrength.value * r * 0.75
  out.set(x + (dx / dist) * g, y + (dy / dist) * g, z + (dz / dist) * g)
  return out
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

let pickAcc = 0
function pick() {
  const n = state.store ? state.store.count : 0
  const mvp = new THREE.Matrix4().multiplyMatrices(cloud.camera.projectionMatrix, cloud.camera.matrixWorldInverse)
  let best = -1, bestScore = Infinity
  const RADIUS = 0.055 // in NDC
  for (let i = 0; i < n; i++) {
    worldPos(i, _v).applyMatrix4(mvp)
    if (_v.z < -1 || _v.z > 1) continue
    const dx = _v.x - mouse.x, dy = _v.y - mouse.y
    const d2 = dx * dx + dy * dy
    if (d2 > RADIUS * RADIUS) continue
    const score = d2 + _v.z * 0.004
    if (score < bestScore) { bestScore = score; best = i }
  }
  return best
}

/* ---------- relevance: what you're looking for ---------- */

function relevanceFrom(vec) {
  const { sim, simDim } = state
  const n = state.store.count
  const rel = cloud.rel
  for (let i = 0; i < n; i++) {
    let d = 0
    const o = i * simDim
    for (let c = 0; c < simDim; c++) d += sim[o + c] * vec[c]
    rel[i] = d * 0.5 + 0.5 // cosine -> 0..1
  }
  // Stretch the top of the range so only genuinely close matches light up.
  let max = 0
  for (let i = 0; i < n; i++) if (rel[i] > max) max = rel[i]
  const lo = 0.5
  const scale = 1 / Math.max(0.05, max - lo)
  for (let i = 0; i < n; i++) rel[i] = Math.max(0, (rel[i] - lo) * scale)
  cloud.relevanceChanged()
}

function relevanceFromPoint(i) {
  relevanceFrom(state.sim.subarray(i * state.simDim, (i + 1) * state.simDim))
}

export function applyQuery(vector) {
  state.query = vector
  if (vector) relevanceFrom(vector)
  state.relTarget = vector ? 1 : 0
  if (vector) flyToMatches()
}

function flyToMatches() {
  const rel = cloud.rel
  const idx = Array.from({ length: state.store.count }, (_, i) => i).sort((a, b) => rel[b] - rel[a]).slice(0, 40)
  const c = new THREE.Vector3()
  const p = new THREE.Vector3()
  for (const i of idx) c.add(worldPos(i, p))
  c.divideScalar(idx.length)
  state.flyTo = c
  ui.showMatches(idx.slice(0, 8))
}

/* ---------- frame loop ---------- */

const LAYOUT_TARGETS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

let last = performance.now()

/** One simulation + render step. Split out from the rAF driver so the view can
 *  be advanced deterministically (tests, headless capture). */
function frame(dt, now = performance.now()) {

  targetWeights.set(...LAYOUT_TARGETS[state.layout])
  weights.lerp(targetWeights, 1 - Math.pow(0.002, dt))
  cloud.uniforms.uWeights.value.copy(weights)
  cloud.uniforms.uColorMode.value = state.colorMode
  cloud.uniforms.uSelSession.value = state.selSession
  cloud.uniforms.uLiveOnly.value = state.liveOnly ? 1 : 0

  pickAcc += dt
  if (pickAcc > 0.045 && state.layouts) {
    pickAcc = 0
    const hit = pick()
    if (hit !== state.hover) {
      state.hover = hit
      dwellAt = now
      ui.hover(hit)
      if (hit >= 0 && !state.query) relevanceFromPoint(hit)
    }
  }

  // The lens follows the cursor: focus eases onto the hovered point, and the
  // cloud's response ramps in with dwell so a fast sweep doesn't thrash.
  const focus = cloud.uniforms.uFocus.value
  if (state.hover >= 0) {
    worldPos(state.hover, _v)
    focus.lerp(_v, 1 - Math.pow(0.001, dt))
    state.relTarget = state.query ? 1 : Math.min(1, (now - dwellAt) / 260)
  } else if (!state.query) {
    state.relTarget = 0
  }
  state.relActive += (state.relTarget - state.relActive) * (1 - Math.pow(0.02, dt))
  cloud.uniforms.uRelActive.value = state.relActive

  // Adaptive zoom: dwelling on a point draws the camera in toward it; with
  // nothing under the cursor the view eases back out to frame the whole cloud.
  if (state.adaptive && now - state.lastUserZoom > 1200) {
    const ctl = cloud.controls
    const dir = cloud.camera.position.clone().sub(ctl.target)
    const dist = dir.length()
    const k = 1 - Math.pow(0.3, dt)
    let goal, want
    if (state.flyTo) {
      goal = state.flyTo
      want = 46
    } else if (state.hover >= 0) {
      goal = focus
      want = THREE.MathUtils.lerp(dist, 34, Math.min(1, ((now - dwellAt) / 1000) * 0.22))
    } else {
      goal = HOME
      want = THREE.MathUtils.lerp(dist, 92, 0.03)
    }
    ctl.target.lerp(goal, k * 0.3)
    dir.setLength(THREE.MathUtils.lerp(dist, THREE.MathUtils.clamp(want, 18, 240), k * 0.35))
    cloud.camera.position.copy(ctl.target).add(dir)
    if (state.flyTo && cloud.camera.position.distanceTo(state.flyTo) < 70) state.flyTo = null
  }

  updateLabels()
  cloud.render(dt)
}

const _l = new THREE.Vector3()
let labelAcc = 0

/** Screen-space markers for the conversations that are running right now. */
function updateLabels(force) {
  const store = state.store
  if (!store) return
  labelAcc += 1
  if (!force && labelAcc % 6) return
  const items = []
  for (const sessionId of store.liveSessions) {
    const idx = store.indexOfSession.get(sessionId)
    if (idx === undefined) continue
    const island = store.island.get(idx)
    if (!island) continue
    _l.set(island.center[0], island.center[1] + island.radius + 2, island.center[2]).project(cloud.camera)
    if (_l.z < -1 || _l.z > 1) continue
    const s = state.meta.sessions[idx]
    const act = state.liveActivity?.get(sessionId)
    items.push({
      x: (_l.x * 0.5 + 0.5) * innerWidth,
      y: (-_l.y * 0.5 + 0.5) * innerHeight,
      name: (s.projectPath || '').split('/').pop() || s.sessionId.slice(0, 8),
      act: act ? `${act.tool || act.kind} · ${act.snippet.slice(0, 46)}…` : '',
      // Ping only while turns are actually landing; a session sitting idle
      // should not read as busy.
      busy: !!act && Date.now() - act.at < 60_000,
    })
  }
  ui.labels(items)
}

function animate() {
  requestAnimationFrame(animate)
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  frame(dt, now)
}

/** Opens on the work in progress: frame the running conversations. */
let framedLive = false
function frameLive() {
  const store = state.store
  if (!store || framedLive || !state.followLive) return
  const centers = []
  for (const sessionId of store.liveSessions) {
    const idx = store.indexOfSession.get(sessionId)
    const island = idx !== undefined && store.island.get(idx)
    if (island) centers.push(island)
  }
  if (!centers.length) return
  framedLive = true
  const c = new THREE.Vector3()
  for (const i of centers) c.add(new THREE.Vector3(...i.center))
  c.divideScalar(centers.length)
  let span = 0
  for (const i of centers) span = Math.max(span, c.distanceTo(new THREE.Vector3(...i.center)) + i.radius)
  cloud.controls.target.copy(c)
  cloud.camera.position.copy(c).add(new THREE.Vector3(0, span * 0.5 + 8, span * 2.2 + 34))
}

/* ---------- panels ---------- */

function pin(i) {
  state.pinned = i
  state.selSession = state.cols.session[i]
  ui.detail(i, nearest(i, 6))
}

function nearest(i, k) {
  const { sim, simDim } = state
  const n = state.store.count
  const scores = new Float32Array(n)
  const o = i * simDim
  for (let j = 0; j < n; j++) {
    if (j === i) continue
    let d = 0
    const jo = j * simDim
    for (let c = 0; c < simDim; c++) d += sim[o + c] * sim[jo + c]
    scores[j] = d
  }
  return Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a]).slice(0, k)
}

ui.bind({
  onQuery: async (q) => {
    if (!q) return applyQuery(null)
    const r = await (await api('/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q }),
    })).json()
    if (r.vector) applyQuery(Float32Array.from(r.vector))
  },
  onFocusPoint: (i) => { state.hover = i; pin(i); worldPos(i, _v); state.flyTo = _v.clone() },
  onSelectSession: (sid) => {
    const idx = state.meta.sessions.findIndex((s) => s.sessionId === sid)
    if (idx < 0) return
    state.selSession = idx
    const first = state.cols.session.indexOf(idx)
    if (first >= 0) { worldPos(first, _v); state.flyTo = _v.clone() }
  },
  cloud,
  KIND_COLORS,
})

addEventListener('unhandledrejection', (e) => ui.bootMessage(`failed: ${e.reason?.message || e.reason}`, 0))

boot().catch((e) => {
  console.error(e)
  ui.bootMessage(`failed: ${e.message}`, 0)
})
