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
  home: { target: new THREE.Vector3(0, 0, 0), dist: 92 },
  manual: false,
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
let settled = false

addEventListener('pointermove', (e) => {
  const x = (e.clientX / innerWidth) * 2 - 1
  const y = -(e.clientY / innerHeight) * 2 + 1
  // Sub-pixel noise is not movement; a resting hand must read as at rest.
  if (Math.abs(x - mouse.x) < 1e-4 && Math.abs(y - mouse.y) < 1e-4) return
  mouse.x = x
  mouse.y = y
  cursorMoved = true
  state.manual = false // the cursor is driving again
  ui.cursor(e.clientX, e.clientY)
  mouseMovedAt = performance.now()
})
addEventListener('wheel', () => { state.lastUserZoom = performance.now() }, { passive: true })

// Navigating by hand sticks: adopt wherever the user left the camera as the
// resting pose, and stay out of the way until the cursor drives again.
cloud.controls.addEventListener('start', () => {
  state.lastUserZoom = performance.now()
  state.manual = true
  settled = false
})
cloud.controls.addEventListener('end', () => {
  state.lastUserZoom = performance.now()
  state.home.target.copy(cloud.controls.target)
  state.home.dist = cloud.camera.position.distanceTo(cloud.controls.target)
})
document.getElementById('stage').addEventListener('pointerdown', () => { state.downAt = performance.now() })
document.getElementById('stage').addEventListener('pointerup', (e) => {
  if (performance.now() - (state.downAt || 0) > 240) return // a drag, not a pick
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

  // Picking runs only when the cursor has actually moved (or while a layout
  // morph is still shifting points under it). The lens displaces points and
  // picking reads those displaced positions, so re-picking under a stationary
  // cursor would feed the view back into itself.
  const morphing = weights.manhattanDistanceTo(targetWeights) > 0.002
  pickAcc += dt
  if (state.layouts && (cursorMoved || morphing) && pickAcc > 0.045) {
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

  updateCamera(dt, now, focus)

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
 * Where the camera wants to be, as a function of what is under the cursor
 * right now — never of how long it has been there. A pose that integrated
 * dwell time would keep creeping while the cursor sat still.
 */
function desiredPose(focus, out) {
  if (state.flyTo) {
    out.target.copy(state.flyTo)
    out.dist = 46
    return out
  }
  if (state.hover >= 0 && !state.manual) {
    out.target.copy(focus)
    // Close enough to read the conversation you are pointing at, sized to that
    // conversation's own island rather than a fixed number.
    const island = state.store?.island.get(state.cols.session[state.hover])
    out.dist = THREE.MathUtils.clamp((island ? island.radius : 8) * 3.2 + 10, 16, 90)
    return out
  }
  out.target.copy(state.home.target)
  out.dist = state.home.dist
  return out
}

const pose = { target: new THREE.Vector3(), dist: 92 }

/**
 * Eases toward the desired pose and then stops writing to the camera at all.
 * "Settled" has to mean no further motion, not asymptotically less of it.
 */
function updateCamera(dt, now, focus) {
  if (!state.adaptive || now - state.lastUserZoom < 900) return
  desiredPose(focus, pose)

  const ctl = cloud.controls
  const dir = cloud.camera.position.clone().sub(ctl.target)
  const dist = dir.length()
  const offTarget = ctl.target.distanceTo(pose.target)
  const offDist = Math.abs(dist - pose.dist)

  if (offTarget < 0.05 && offDist < 0.1) {
    if (!settled) {
      // Land exactly on the pose once, then leave the camera alone entirely.
      ctl.target.copy(pose.target)
      cloud.camera.position.copy(pose.target).add(dir.setLength(pose.dist))
      settled = true
      if (state.flyTo) state.flyTo = null
    }
    return
  }

  settled = false
  const k = (1 - Math.pow(0.02, dt)) * 0.5
  ctl.target.lerp(pose.target, k)
  dir.setLength(THREE.MathUtils.lerp(dist, pose.dist, k))
  cloud.camera.position.copy(ctl.target).add(dir)
}

/**
 * Restrict the cloud to conversations whose process is still running.
 *
 * "Active" is the process being alive, not Claude currently inferring — a
 * session waiting on you is still yours to keep an eye on. Everything else is
 * finished history: it is what made the view unreadably dense, so by default it
 * is not drawn at all, and what remains is scaled up to fill the space.
 */
function applyFilter() {
  const store = state.store
  if (!store) return

  const active = new Set()
  for (const sid of store.liveSessions) {
    const i = store.indexOfSession.get(sid)
    if (i !== undefined) active.add(i)
  }
  state.activeSessions = active

  const on = state.activeOnly && active.size > 0
  const vis = state.arrays.aVisible.array
  let shown = 0
  for (let i = 0; i < store.count; i++) {
    const v = on ? (active.has(state.cols.session[i]) ? 1 : 0) : 1
    vis[i] = v
    shown += v
  }
  cloud.geometry.getAttribute('aVisible').needsUpdate = true
  state.shown = shown

  // Reclaim the space the archive was using.
  const c = cloud.uniforms.uFilterCenter.value
  let scale = 1
  if (on) {
    const centers = [...active].map((i) => store.island.get(i)).filter(Boolean)
    if (centers.length) {
      c.set(0, 0, 0)
      for (const is of centers) c.add(new THREE.Vector3(...is.center))
      c.divideScalar(centers.length)
      let extent = 0
      for (const is of centers)
        extent = Math.max(extent, c.distanceTo(new THREE.Vector3(...is.center)) + is.radius)
      scale = THREE.MathUtils.clamp(52 / Math.max(extent, 1), 1, 7)
    }
  } else {
    c.set(0, 0, 0)
  }
  cloud.uniforms.uFilterScale.value = scale
  cloud.syncFilterTransform()

  cloud.setThreads(threadSegments(state.arrays.position.array, state.cols, 16, (i) => vis[i] > 0, store.count))
  ui.shown(shown, store.count, active.size)
  framedLive = false
  settled = false
  frameLive()
}

/**
 * Shift attention when a *different* conversation picks up the work.
 *
 * Flying to every arriving turn meant a busy session dragged the camera around
 * every few seconds with the cursor untouched — motion the viewer never asked
 * for. Turns landing in the conversation we are already watching are conveyed
 * by their arrival flare instead, which costs no camera movement at all.
 */
let followed = null
function followLive(msg, added) {
  if (!state.followLive || !added.length) return
  if (msg.sessionId === followed) return
  // Never yank the view while it is being read or driven by hand.
  if (state.hover >= 0 || state.manual) return
  followed = msg.sessionId
  worldPos(added[added.length - 1], _v, false)
  state.flyTo = _v.clone()
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
  const fc = cloud.uniforms.uFilterCenter.value
  const fs = cloud.uniforms.uFilterScale.value
  const world = (i) => new THREE.Vector3(...i.center).sub(fc).multiplyScalar(fs).add(fc)
  const c = new THREE.Vector3()
  for (const i of centers) c.add(world(i))
  c.divideScalar(centers.length)
  let span = 0
  for (const i of centers) span = Math.max(span, c.distanceTo(world(i)) + i.radius * fs)
  cloud.controls.target.copy(c)
  cloud.camera.position.copy(c).add(new THREE.Vector3(0, span * 0.5 + 8, span * 2.2 + 34))
  state.home.target.copy(c)
  state.home.dist = cloud.camera.position.distanceTo(c)
  settled = false
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
  onFilterChange: () => applyFilter(),
  cloud,
  KIND_COLORS,
})

addEventListener('unhandledrejection', (e) => ui.bootMessage(`failed: ${e.reason?.message || e.reason}`, 0))

boot().catch((e) => {
  console.error(e)
  ui.bootMessage(`failed: ${e.message}`, 0)
})
