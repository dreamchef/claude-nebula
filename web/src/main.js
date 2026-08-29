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
  autoFrame: true, // fly to search hits and to whichever conversation picks up work
  relActive: 0,
  relTarget: 0,
  query: null,
  selSession: -1,
  home: { target: new THREE.Vector3(0, 0, 0), dist: 92 },
  driving: false,
  followLive: true,
  activeOnly: true,
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
    aVisible: { array: new Float32Array(cap).fill(1), size: 1 },
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
  applyFilter()
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
      applyFilter()
    },
    onPoints: (msg, added, activity) => {
      cloud.grow(state.store.count)
      for (let i = 0; i < added.length; i++) state.arrays.aVisible.array[added[i]] = 1
      state.liveActivity = activity
      ui.activity(msg, activity)
      updateLabels(true)
      followLive(msg, added)
    },
    onDisconnect: () => ui.liveState(false),
  }).connect()
}

/* ---------- cursor focus ---------- */

const mouse = new THREE.Vector2(-2, -2)
let mouseMovedAt = 0
let dwellAt = 0
let cursorMoved = false

addEventListener('pointermove', (e) => {
  const x = (e.clientX / innerWidth) * 2 - 1
  const y = -(e.clientY / innerHeight) * 2 + 1
  // Sub-pixel noise is not movement; a resting hand must read as at rest.
  if (Math.abs(x - mouse.x) < 1e-4 && Math.abs(y - mouse.y) < 1e-4) return
  mouse.x = x
  mouse.y = y
  cursorMoved = true
  ui.cursor(e.clientX, e.clientY)
  mouseMovedAt = performance.now()
})
// Any touch of the controls takes the camera, and keeps it: `driving` is held
// for the whole gesture rather than being cleared by the pointermoves a drag
// is made of.
addEventListener('wheel', () => { cancelFlight() }, { passive: true })
cloud.controls.addEventListener('start', () => { state.driving = true; cancelFlight() })
cloud.controls.addEventListener('end', () => {
  state.driving = false
  state.home.target.copy(cloud.controls.target)
  state.home.dist = cloud.camera.position.distanceTo(cloud.controls.target)
})
document.getElementById('stage').addEventListener('pointerdown', (e) => {
  state.downX = e.clientX
  state.downY = e.clientY
})
document.getElementById('stage').addEventListener('pointerup', (e) => {
  // A slow, deliberate click is still a click; what makes it a drag is that the
  // pointer travelled.
  if (Math.hypot(e.clientX - state.downX, e.clientY - state.downY) > 5) return
  if (state.hover >= 0) pin(state.hover)
  else { state.pinned = -1; state.selSession = -1; ui.closeDetail() }
})

const _v = new THREE.Vector3()
const weights = new THREE.Vector3(1, 0, 0)
const targetWeights = new THREE.Vector3(1, 0, 0)

/**
 * Mirrors the vertex shader so screen-space picking hits what is actually
 * drawn. `lens` is off when we need a point's settled position: the lens is
 * centred on the focus, so feeding a lens-displaced position back in as the
 * focus is circular — and at distance zero its direction is degenerate, which
 * is enough to make a stationary view jitter.
 */
function worldPos(i, out, lens = true) {
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

  const fc = f.uFilterCenter.value
  const fs = f.uFilterScale.value
  if (fs !== 1) {
    x = fc.x + (x - fc.x) * fs
    y = fc.y + (y - fc.y) * fs
    z = fc.z + (z - fc.z) * fs
  }

  if (!lens) return out.set(x, y, z)

  const dx = x - fx.x, dy = y - fx.y, dz = z - fx.z
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
  let heldScore = Infinity
  const RADIUS = 0.055 // in NDC
  const vis = state.arrays.aVisible.array
  for (let i = 0; i < n; i++) {
    if (vis[i] < 0.5) continue
    worldPos(i, _v).applyMatrix4(mvp)
    if (_v.z < -1 || _v.z > 1) continue
    const dx = _v.x - mouse.x, dy = _v.y - mouse.y
    const d2 = dx * dx + dy * dy
    if (i === state.hover) heldScore = d2 + _v.z * 0.004
    if (d2 > RADIUS * RADIUS) continue
    const score = d2 + _v.z * 0.004
    if (score < bestScore) { bestScore = score; best = i }
  }
  // Keep the point we are already on unless a rival is clearly nearer, so
  // neighbours in a dense cluster cannot trade the hover back and forth.
  if (state.hover >= 0 && best !== state.hover && heldScore < RADIUS * RADIUS && bestScore > heldScore * 0.55)
    return state.hover
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
  flyTo(c, 46)
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

  // Picking runs only when the cursor has actually moved (or while a layout
  // morph is still shifting points under it). The lens displaces points and
  // picking reads those displaced positions, so re-picking under a stationary
  // cursor would feed the view back into itself.
  const morphing = weights.manhattanDistanceTo(targetWeights) > 0.002
  const cam = cloud.camera.position
  const cameraMoved =
    lastCam.distanceToSquared(cam) > 1e-6 || lastTarget.distanceToSquared(cloud.controls.target) > 1e-6
  lastCam.copy(cam)
  lastTarget.copy(cloud.controls.target)

  pickAcc += dt
  if (state.layouts && (cursorMoved || cameraMoved || morphing) && pickAcc > 0.045) {
    pickAcc = 0
    cursorMoved = false
    const hit = pick()
    if (hit !== state.hover) {
      state.hover = hit
      dwellAt = now
      ui.hover(hit)
      if (hit >= 0 && !state.query) relevanceFromPoint(hit)
    }
  }

  // The lens follows the cursor. Focus tracks the hovered point's settled
  // position and snaps once it arrives, so a still cursor leaves it still.
  const focus = cloud.uniforms.uFocus.value
  if (state.hover >= 0) {
    worldPos(state.hover, _v, false)
    if (focus.distanceToSquared(_v) < 1e-4) focus.copy(_v)
    else focus.lerp(_v, 1 - Math.pow(0.001, dt))
    state.relTarget = state.query ? 1 : Math.min(1, (now - dwellAt) / 260)
  } else if (!state.query) {
    state.relTarget = 0
  }
  state.relActive += (state.relTarget - state.relActive) * (1 - Math.pow(0.02, dt))
  cloud.uniforms.uRelActive.value = state.relActive

  updateCamera(dt)

  updateLabels()
  cloud.render(dt)
}

const _l = new THREE.Vector3()
const lastCam = new THREE.Vector3()
const lastTarget = new THREE.Vector3()
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
    // Islands are stored unscaled; the filter's rescale has to be applied here
    // too or the label drifts off its own cluster.
    const fc = cloud.uniforms.uFilterCenter.value
    const fs = cloud.uniforms.uFilterScale.value
    _l.set(island.center[0], island.center[1] + island.radius + 2, island.center[2])
      .sub(fc).multiplyScalar(fs).add(fc)
      .project(cloud.camera)
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

/**
 * Automatic camera movement, and the rules it lives by.
 *
 * The camera belongs to whoever is dragging it. Earlier this eased toward a
 * pose derived from whatever was under the cursor, which meant merely moving
 * the mouse threw the view across the cloud, a drag longer than the grace
 * period got fought mid-gesture, and the pose's distance term quietly undid
 * every scroll. The cursor now drives the lens and nothing else.
 *
 * What is left is a finite flight, used only for things the viewer actually
 * asked for — a search result, a neighbour, a different conversation picking up
 * the work — and any touch of the controls cancels it on the spot.
 */
const flight = {
  active: false,
  t: 0,
  dur: 0.85,
  fromTarget: new THREE.Vector3(),
  toTarget: new THREE.Vector3(),
  fromDist: 0,
  toDist: 0,
}

export function flyTo(target, dist) {
  if (!state.autoFrame || state.driving) return
  const ctl = cloud.controls
  flight.fromTarget.copy(ctl.target)
  flight.toTarget.copy(target)
  flight.fromDist = cloud.camera.position.distanceTo(ctl.target)
  flight.toDist = dist ?? flight.fromDist
  flight.t = 0
  flight.active = true
}

function cancelFlight() {
  flight.active = false
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const _dir = new THREE.Vector3()

function updateCamera(dt) {
  if (!flight.active) return
  // Never wrestle the user for the camera.
  if (state.driving) return cancelFlight()

  flight.t = Math.min(1, flight.t + dt / flight.dur)
  const k = easeInOut(flight.t)
  const ctl = cloud.controls
  _dir.copy(cloud.camera.position).sub(ctl.target)
  ctl.target.lerpVectors(flight.fromTarget, flight.toTarget, k)
  _dir.setLength(THREE.MathUtils.lerp(flight.fromDist, flight.toDist, k))
  cloud.camera.position.copy(ctl.target).add(_dir)
  if (flight.t >= 1) flight.active = false
}

/**
 * Open on the work in progress. The very first framing is instant — there is
 * nothing to preserve yet — but every later one is a flight the viewer can
 * cancel simply by touching the controls.
 */
let framedOnce = false
let activeSig = null
function frameLive() {
  const store = state.store
  if (!store || !state.followLive) return
  const centers = []
  for (const sessionId of store.liveSessions) {
    const idx = store.indexOfSession.get(sessionId)
    const island = idx !== undefined && store.island.get(idx)
    if (island) centers.push(island)
  }
  if (!centers.length) return

  const fc = cloud.uniforms.uFilterCenter.value
  const fs = cloud.uniforms.uFilterScale.value
  const world = (i) => new THREE.Vector3(...i.center).sub(fc).multiplyScalar(fs).add(fc)
  const c = new THREE.Vector3()
  for (const i of centers) c.add(world(i))
  c.divideScalar(centers.length)
  let span = 0
  for (const i of centers) span = Math.max(span, c.distanceTo(world(i)) + i.radius * fs)
  const dist = span * 2.2 + 34

  state.home.target.copy(c)
  state.home.dist = dist

  if (!framedOnce) {
    framedOnce = true
    cloud.controls.target.copy(c)
    cloud.camera.position.copy(c).add(new THREE.Vector3(0, span * 0.5 + 8, dist))
    return
  }
  flyTo(c, dist)
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
  onFocusPoint: (i) => { state.hover = i; pin(i); worldPos(i, _v, false); flyTo(_v, 34) },
  onSelectSession: (sid) => {
    const idx = state.meta.sessions.findIndex((s) => s.sessionId === sid)
    if (idx < 0) return
    state.selSession = idx
    const first = state.cols.session.indexOf(idx)
    if (first >= 0) { worldPos(first, _v, false); flyTo(_v, 40) }
  },
  onFilterChange: () => applyFilter(),
  cloud,
  KIND_COLORS,
})

addEventListener('unhandledrejection', (e) => ui.bootMessage(`failed: ${e.reason?.message || e.reason}`, 0))

boot().catch((e) => {
  console.error(e)
  ui.bootMessage(`failed: ${e.message}`, 0)
})
