/**
 * The three arrangements the cloud can morph between. All are computed once on
 * the client from the compact column arrays the API serves.
 */
const GOLDEN = 2.399963229728653

export function timeLayout(meta, cols) {
  const n = cols.session.length
  const out = new Float32Array(n * 3)
  const order = meta.sessions.map((s) => s.i).sort((a, b) => (meta.sessions[a].start || 0) - (meta.sessions[b].start || 0))
  const rank = new Map(order.map((s, i) => [s, i]))
  const counts = new Int32Array(meta.sessions.length)
  const seen = new Int32Array(meta.sessions.length)
  for (let i = 0; i < n; i++) counts[cols.session[i]]++

  const TURNS = 3.2
  const R = 34
  for (let i = 0; i < n; i++) {
    const s = cols.session[i]
    const u = rank.get(s) / Math.max(1, meta.sessions.length - 1)
    const a = u * TURNS * Math.PI * 2
    const cx = Math.cos(a) * R, cz = Math.sin(a) * R, cy = (u - 0.5) * 62
    // Tangent of the spiral, so a conversation reads left-to-right along it.
    const tx = -Math.sin(a), tz = Math.cos(a)
    const j = seen[s]++
    const m = Math.max(1, counts[s] - 1)
    const along = (j / m - 0.5) * Math.min(17, 2 + counts[s] * 0.15)
    const twist = j * 0.55
    out[i * 3] = cx + tx * along + Math.cos(twist) * 2.4
    out[i * 3 + 1] = cy + Math.sin(twist) * 2.4
    out[i * 3 + 2] = cz + tz * along
  }
  return out
}

export function projectLayout(meta, cols) {
  const n = cols.session.length
  const out = new Float32Array(n * 3)

  const byProject = new Map()
  for (const s of meta.sessions) {
    const key = s.projectPath || s.project
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key).push(s.i)
  }
  const projects = [...byProject.entries()].sort(
    (a, b) => b[1].reduce((t, i) => t + meta.sessions[i].points, 0) - a[1].reduce((t, i) => t + meta.sessions[i].points, 0)
  )

  const slot = new Map()
  projects.forEach(([, ids], pi) => {
    const r = 9 + 7.4 * Math.sqrt(pi)
    const a = pi * GOLDEN
    const base = [Math.cos(a) * r, 0, Math.sin(a) * r]
    ids.forEach((sid, si) => {
      const sr = 1.4 + 1.5 * Math.sqrt(si)
      const sa = si * GOLDEN
      slot.set(sid, [base[0] + Math.cos(sa) * sr, base[1], base[2] + Math.sin(sa) * sr])
    })
  })

  const counts = new Int32Array(meta.sessions.length)
  const seen = new Int32Array(meta.sessions.length)
  for (let i = 0; i < n; i++) counts[cols.session[i]]++
  for (let i = 0; i < n; i++) {
    const s = cols.session[i]
    const [x, y, z] = slot.get(s) || [0, 0, 0]
    const j = seen[s]++
    const h = Math.log2(counts[s] + 1) * 7
    const t = j / Math.max(1, counts[s] - 1)
    // A column, not a wire: points wind around the session's axis so a busy
    // conversation reads as a thicker pillar.
    const w = 0.6 + 1.3 * Math.sqrt(t)
    out[i * 3] = x + Math.cos(j * GOLDEN) * w
    out[i * 3 + 1] = y - 18 + t * h
    out[i * 3 + 2] = z + Math.sin(j * GOLDEN) * w
  }
  return out
}

/**
 * Line segments joining consecutive points within each conversation. Jumps
 * across the whole cloud are dropped: they say nothing about local structure
 * and would otherwise draw a web of long chords over everything.
 */
export function threadSegments(pos, cols, maxLen = 16, visible = null, count = null) {
  const n = count ?? cols.session.length
  const segs = []
  const max2 = maxLen * maxLen
  for (let i = 1; i < n; i++) {
    if (cols.session[i] !== cols.session[i - 1]) continue
    if (visible && (!visible(i) || !visible(i - 1))) continue
    const a = (i - 1) * 3, b = i * 3
    const d2 = (pos[a] - pos[b]) ** 2 + (pos[a + 1] - pos[b + 1]) ** 2 + (pos[a + 2] - pos[b + 2]) ** 2
    if (d2 > max2) continue
    segs.push(pos[(i - 1) * 3], pos[(i - 1) * 3 + 1], pos[(i - 1) * 3 + 2], pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
  }
  return new Float32Array(segs)
}
