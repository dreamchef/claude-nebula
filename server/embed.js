import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CACHE_DIR = path.join(ROOT, '.cache')
const VEC_BIN = path.join(CACHE_DIR, 'vectors.bin')
const VEC_MAP = path.join(CACHE_DIR, 'vectors.json')

export const MODEL = process.env.NEBULA_MODEL || 'Xenova/all-MiniLM-L6-v2'
export const DIM = 384

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20)

/**
 * Content-addressed vector store. Embedding text is the expensive part of
 * indexing and transcripts are append-only, so keying by text hash means a
 * re-index only pays for genuinely new conversation.
 */
export class VectorCache {
  constructor() {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    this.map = fs.existsSync(VEC_MAP) ? JSON.parse(fs.readFileSync(VEC_MAP, 'utf8')) : {}
    this.count = Object.keys(this.map).length
    this.buf = fs.existsSync(VEC_BIN) ? fs.readFileSync(VEC_BIN) : Buffer.alloc(0)
    this.pending = []
    // A truncated store (interrupted write) would hand back garbage vectors.
    if (this.buf.length < this.count * DIM * 4) { this.map = {}; this.count = 0; this.buf = Buffer.alloc(0) }
  }

  get(text) {
    const i = this.map[hash(text)]
    if (i === undefined) return null
    return new Float32Array(this.buf.buffer, this.buf.byteOffset + i * DIM * 4, DIM)
  }

  put(text, vec) {
    const h = hash(text)
    if (this.map[h] !== undefined) return
    this.map[h] = this.count++
    this.pending.push(Buffer.from(Float32Array.from(vec).buffer))
  }

  flush() {
    if (this.pending.length) {
      fs.appendFileSync(VEC_BIN, Buffer.concat(this.pending))
      this.pending = []
      this.buf = fs.readFileSync(VEC_BIN)
    }
    fs.writeFileSync(VEC_MAP, JSON.stringify(this.map))
  }
}

let extractorPromise = null

export async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then(({ pipeline, env }) => {
      env.cacheDir = path.join(CACHE_DIR, 'models')
      return pipeline('feature-extraction', MODEL, { dtype: 'fp32' })
    })
  }
  return extractorPromise
}

/** Embeds texts through the cache, reporting progress for the long first run. */
export async function embedAll(texts, onProgress = () => {}) {
  const cache = new VectorCache()
  const out = new Float32Array(texts.length * DIM)
  const todo = []

  for (let i = 0; i < texts.length; i++) {
    const hit = cache.get(texts[i])
    if (hit) out.set(hit, i * DIM)
    else todo.push(i)
  }

  onProgress({ phase: 'embed', done: texts.length - todo.length, total: texts.length, cached: true })
  if (todo.length === 0) return out

  const extractor = await getExtractor()
  const BATCH = 32
  for (let b = 0; b < todo.length; b += BATCH) {
    const idx = todo.slice(b, b + BATCH)
    const res = await extractor(idx.map((i) => texts[i]), { pooling: 'mean', normalize: true })
    const data = res.data
    idx.forEach((i, k) => {
      const vec = data.subarray(k * DIM, (k + 1) * DIM)
      out.set(vec, i * DIM)
      cache.put(texts[i], vec)
    })
    if (b % (BATCH * 20) === 0) cache.flush()
    onProgress({ phase: 'embed', done: texts.length - todo.length + b + idx.length, total: texts.length })
  }
  cache.flush()
  return out
}

/** Embeds one ad-hoc string (search queries) without touching the bulk cache. */
export async function embedOne(text) {
  const cache = new VectorCache()
  const hit = cache.get(text)
  if (hit) return Float32Array.from(hit)
  const extractor = await getExtractor()
  const res = await extractor([text], { pooling: 'mean', normalize: true })
  const vec = Float32Array.from(res.data.subarray(0, DIM))
  cache.put(text, vec)
  cache.flush()
  return vec
}
