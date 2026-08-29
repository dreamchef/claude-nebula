/**
 * Dimensionality reduction and layout, dependency-free.
 *
 * Pipeline: MiniLM vectors -> randomized PCA (fast, gives both a cheap
 * similarity space for the client and a sane layout initialisation) -> LSH
 * approximate kNN -> UMAP-style attractive/repulsive SGD in 3D.
 */

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function orthonormalize(M, rows, k) {
  for (let c = 0; c < k; c++) {
    for (let p = 0; p < c; p++) {
      let d = 0
      for (let r = 0; r < rows; r++) d += M[r * k + c] * M[r * k + p]
      for (let r = 0; r < rows; r++) M[r * k + c] -= d * M[r * k + p]
    }
    let n = 0
    for (let r = 0; r < rows; r++) n += M[r * k + c] ** 2
    n = Math.sqrt(n) || 1
    for (let r = 0; r < rows; r++) M[r * k + c] /= n
  }
  return M
}

function matmul(A, ar, ac, B, bc) {
  const out = new Float32Array(ar * bc)
  for (let i = 0; i < ar; i++) {
    const ao = i * ac, oo = i * bc
    for (let t = 0; t < ac; t++) {
      const a = A[ao + t]
      if (a === 0) continue
      const bo = t * bc
      for (let j = 0; j < bc; j++) out[oo + j] += a * B[bo + j]
    }
  }
  return out
}

/**
 * Randomized subspace-iteration PCA. Components are estimated from a random
 * subsample (plenty for the leading directions) and then applied to every row,
 * which keeps a 13k x 384 reduction to a couple of seconds.
 */
export function pca(X, n, dim, k, { sample = 4000, iters = 3, seed = 7 } = {}) {
  const rand = rng(seed)
  const m = Math.min(n, sample)
  const rows = new Int32Array(m)
  if (m === n) for (let i = 0; i < n; i++) rows[i] = i
  else for (let i = 0; i < m; i++) rows[i] = Math.floor(rand() * n)

  const mean = new Float32Array(dim)
  for (let i = 0; i < m; i++) {
    const o = rows[i] * dim
    for (let d = 0; d < dim; d++) mean[d] += X[o + d]
  }
  for (let d = 0; d < dim; d++) mean[d] /= m

  const S = new Float32Array(m * dim)
  for (let i = 0; i < m; i++) {
    const o = rows[i] * dim, so = i * dim
    for (let d = 0; d < dim; d++) S[so + d] = X[o + d] - mean[d]
  }

  let Q = new Float32Array(dim * k)
  for (let i = 0; i < Q.length; i++) Q[i] = rand() * 2 - 1
  orthonormalize(Q, dim, k)

  for (let it = 0; it < iters; it++) {
    const Y = matmul(S, m, dim, Q, k)             // m x k
    orthonormalize(Y, m, k)
    // Q = S^T Y  (dim x k)
    const Z = new Float32Array(dim * k)
    for (let i = 0; i < m; i++) {
      const so = i * dim, yo = i * k
      for (let d = 0; d < dim; d++) {
        const s = S[so + d]
        if (s === 0) continue
        const zo = d * k
        for (let c = 0; c < k; c++) Z[zo + c] += s * Y[yo + c]
      }
    }
    Q = orthonormalize(Z, dim, k)
  }

  const proj = new Float32Array(n * k)
  for (let i = 0; i < n; i++) {
    const o = i * dim, po = i * k
    for (let d = 0; d < dim; d++) {
      const v = X[o + d] - mean[d]
      if (v === 0) continue
      const qo = d * k
      for (let c = 0; c < k; c++) proj[po + c] += v * Q[qo + c]
    }
  }
  return { mean, components: Q, proj, k }
}

/**
 * Approximate kNN by random-hyperplane LSH: cheap, and neighbour quality only
 * needs to be good enough to shape the layout.
 */
export function knn(P, n, k, K = 16, { tables = 8, bits = 10, seed = 11 } = {}) {
  const rand = rng(seed)
  const cand = Array.from({ length: n }, () => new Set())

  for (let t = 0; t < tables; t++) {
    const planes = new Float32Array(bits * k)
    for (let i = 0; i < planes.length; i++) planes[i] = rand() * 2 - 1
    const buckets = new Map()
    for (let i = 0; i < n; i++) {
      let code = 0
      for (let b = 0; b < bits; b++) {
        let d = 0
        const po = b * k, io = i * k
        for (let c = 0; c < k; c++) d += P[io + c] * planes[po + c]
        if (d > 0) code |= 1 << b
      }
      let arr = buckets.get(code)
      if (!arr) buckets.set(code, (arr = []))
      arr.push(i)
    }
    for (const arr of buckets.values()) {
      if (arr.length < 2) continue
      const cap = Math.min(arr.length, 64)
      for (const i of arr) {
        const s = cand[i]
        for (let j = 0; j < cap; j++) {
          const o = arr[arr.length > 64 ? Math.floor(rand() * arr.length) : j]
          if (o !== i) s.add(o)
        }
      }
    }
  }

  const nbr = new Int32Array(n * K).fill(-1)
  const wgt = new Float32Array(n * K)
  const scored = []
  for (let i = 0; i < n; i++) {
    scored.length = 0
    const io = i * k
    for (const j of cand[i]) {
      let d = 0
      const jo = j * k
      for (let c = 0; c < k; c++) d += (P[io + c] - P[jo + c]) ** 2
      scored.push([d, j])
    }
    scored.sort((a, b) => a[0] - b[0])
    const take = Math.min(K, scored.length)
    const sigma = take ? Math.max(scored[Math.floor(take / 2)][0], 1e-6) : 1
    for (let c = 0; c < take; c++) {
      nbr[i * K + c] = scored[c][1]
      wgt[i * K + c] = Math.exp(-scored[c][0] / sigma)
    }
  }
  return { nbr, wgt, K }
}

/** UMAP-style SGD: neighbours attract, random pairs repel. */
export function layout3d(P, n, k, graph, { epochs = 220, seed = 23, a = 1.6, b = 0.9 } = {}) {
  const rand = rng(seed)
  const { nbr, wgt, K } = graph
  const pos = new Float32Array(n * 3)

  // Initialise from the leading PCA axes so the optimisation starts in a
  // globally sensible configuration rather than pure noise.
  let scale = 0
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) scale = Math.max(scale, Math.abs(P[i * k + c]))
  scale = scale || 1
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) pos[i * 3 + c] = (P[i * k + c] / scale) * 10 + (rand() - 0.5) * 0.2

  const NEG = 5
  const clip = (v) => (v > 4 ? 4 : v < -4 ? -4 : v)

  for (let e = 0; e < epochs; e++) {
    const alpha = 1 - e / epochs
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < K; c++) {
        const j = nbr[i * K + c]
        if (j < 0) continue
        if (rand() > wgt[i * K + c]) continue
        const io = i * 3, jo = j * 3
        let d2 = 0
        for (let d = 0; d < 3; d++) d2 += (pos[io + d] - pos[jo + d]) ** 2
        const grad = (-2 * a * b * Math.pow(d2, b - 1)) / (1 + a * Math.pow(d2, b))
        for (let d = 0; d < 3; d++) {
          const g = clip(grad * (pos[io + d] - pos[jo + d])) * alpha
          pos[io + d] += g
          pos[jo + d] -= g
        }
        for (let s = 0; s < NEG; s++) {
          const r = Math.floor(rand() * n)
          if (r === i) continue
          const ro = r * 3
          let rd2 = 0
          for (let d = 0; d < 3; d++) rd2 += (pos[io + d] - pos[ro + d]) ** 2
          const rgrad = (2 * b) / ((0.001 + rd2) * (1 + a * Math.pow(rd2, b)))
          for (let d = 0; d < 3; d++) pos[io + d] += clip(rgrad * (pos[io + d] - pos[ro + d])) * alpha
        }
      }
    }
  }

  // Centre and normalise into a predictable world-space box.
  const c = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) c[d] += pos[i * 3 + d]
  for (let d = 0; d < 3; d++) c[d] /= n
  let max = 1e-6
  for (let i = 0; i < n; i++)
    for (let d = 0; d < 3; d++) max = Math.max(max, Math.abs(pos[i * 3 + d] - c[d]))
  for (let i = 0; i < n; i++)
    for (let d = 0; d < 3; d++) pos[i * 3 + d] = ((pos[i * 3 + d] - c[d]) / max) * 60
  return pos
}
