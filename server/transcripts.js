import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
export const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects')

const CHUNK = 900
const MAX_CHUNKS = 4
const SNIPPET = 700

/**
 * The directory name is a lossy encoding of the cwd (every non-alphanumeric
 * character becomes a dash), so it cannot be decoded unambiguously. The entries
 * themselves carry the real cwd; read just enough of the head of the file to
 * find one, and fall back to the naive decode only if none is present.
 */
function decodeProjectDir(name) {
  return name.replace(/^-/, '/').replace(/-/g, '/')
}

function sniffCwd(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(96 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/)
    return m ? JSON.parse('"' + m[1] + '"') : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

export function listTranscripts() {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  const out = []
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, proj)
    let st
    try { st = fs.statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const file = path.join(dir, f)
      const fst = fs.statSync(file)
      if (fst.size === 0) continue
      out.push({
        file,
        project: proj,
        projectPath: sniffCwd(file) || decodeProjectDir(proj),
        sessionId: f.replace(/\.jsonl$/, ''),
        size: fst.size,
        mtime: fst.mtimeMs,
      })
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime)
}

function textOf(block) {
  if (typeof block === 'string') return block
  if (!block || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text': return block.text || ''
    case 'thinking': return block.thinking || ''
    case 'tool_use': {
      const input = block.input ? JSON.stringify(block.input) : ''
      return `${block.name}(${input})`
    }
    case 'tool_result': {
      const c = block.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map(textOf).join('\n')
      return ''
    }
    default: return ''
  }
}

function chunks(text) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return []
  if (t.length <= CHUNK) return [t]
  const out = []
  for (let i = 0; i < t.length && out.length < MAX_CHUNKS; i += CHUNK) out.push(t.slice(i, i + CHUNK))
  return out
}

const QUESTION = 260

/** The human turn an entry belongs to, or null if this entry is not one. */
export function humanTurnText(e) {
  if (e.type !== 'user' || !e.message) return null
  const c = e.message.content
  if (typeof c === 'string') return c.slice(0, QUESTION)
  if (!Array.isArray(c)) return null
  const text = c
    .filter((b) => typeof b === 'string' || b?.type === 'text')
    .map((b) => (typeof b === 'string' ? b : b.text || ''))
    .join(' ')
    .trim()
  return text ? text.replace(/\s+/g, ' ').slice(0, QUESTION) : null
}

/**
 * Turns one transcript entry into its points: a text block, a thinking block,
 * a tool call, or a chunk of a long tool result. Shared by the batch indexer
 * and the live tail so both see conversation the same way.
 */
export function extractPoints(e, seqStart = 0, ctx = null) {
  const msg = e.message
  if (!msg) return []
  const ts = e.timestamp ? Date.parse(e.timestamp) : null
  const blocks = Array.isArray(msg.content)
    ? msg.content
    : typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : []

  const out = []
  let seq = seqStart
  for (const b of blocks) {
    const btype = typeof b === 'string' ? 'text' : b?.type
    let kind
    if (btype === 'thinking' || btype === 'redacted_thinking') kind = 'thinking'
    else if (btype === 'tool_use') kind = 'tool'
    else if (btype === 'tool_result') kind = 'result'
    else if (btype === 'text') kind = e.type === 'user' ? 'user' : 'assistant'
    else continue

    const raw = textOf(b)
    const parts = chunks(raw)
    for (let ci = 0; ci < parts.length; ci++) {
      out.push({
        seq: seq++,
        kind,
        // What gets embedded is the turn in the context of the request it
        // belongs to. A bare "ok, that works" carries no meaning on its own and
        // would land wherever short acknowledgements happen to cluster; paired
        // with the question it answers, it lands with the work it is about.
        embedText: ctx?.question && kind !== 'user' ? `${ctx.question}\n\n${parts[ci]}` : parts[ci],
        t: ts,
        tool: btype === 'tool_use' ? b.name : null,
        error: btype === 'tool_result' && b.is_error ? 1 : 0,
        uuid: e.uuid || null,
        chunk: ci,
        chunks: parts.length,
        len: raw.length,
        text: parts[ci],
        snippet: parts[ci].slice(0, SNIPPET),
      })
    }
  }
  return out
}

/**
 * Reads one transcript into a session record plus a flat list of points.
 * A point is one semantically coherent slice of the conversation: a text
 * block, a thinking block, a tool call, or a tool result chunk.
 */
export async function readTranscript(meta) {
  const session = {
    sessionId: meta.sessionId,
    project: meta.project,
    projectPath: meta.projectPath,
    file: meta.file,
    title: null,
    cwd: null,
    gitBranch: null,
    version: null,
    models: {},
    start: null,
    end: null,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    errors: 0,
    isSidechainOnly: true,
  }
  const points = []
  let seq = 0
  const ctx = { question: null }

  const rl = readline.createInterface({
    input: fs.createReadStream(meta.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }

    if (e.type === 'ai-title' && e.aiTitle) { session.title = e.aiTitle; continue }
    if (e.cwd && !session.cwd) session.cwd = e.cwd
    if (e.gitBranch && !session.gitBranch) session.gitBranch = e.gitBranch
    if (e.version) session.version = e.version
    if (e.isSidechain === false) session.isSidechainOnly = false
    if (e.isApiErrorMessage) session.errors++

    if (e.type !== 'user' && e.type !== 'assistant') continue
    const ts = e.timestamp ? Date.parse(e.timestamp) : null
    if (ts) {
      if (session.start === null || ts < session.start) session.start = ts
      if (session.end === null || ts > session.end) session.end = ts
    }

    const msg = e.message
    if (!msg) continue
    if (Array.isArray(msg.content))
      for (const b of msg.content) if (b?.type === 'tool_use') session.toolCalls++

    if (e.type === 'assistant') {
      session.assistantTurns++
      if (msg.model) session.models[msg.model] = (session.models[msg.model] || 0) + 1
      const u = msg.usage
      if (u) {
        session.tokensIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
        session.tokensOut += u.output_tokens || 0
        session.cacheRead += u.cache_read_input_tokens || 0
      }
    } else {
      // A user entry carrying only tool_result blocks is the tool's reply, not a human turn.
      const arr = Array.isArray(msg.content) ? msg.content : null
      const human = !arr || arr.some((b) => b?.type === 'text' || typeof b === 'string')
      if (human) session.userTurns++
    }

    const q = humanTurnText(e)
    if (q) ctx.question = q
    for (const p of extractPoints(e, seq, ctx)) {
      points.push(p)
      seq++
    }
  }

  session.points = points.length
  return { session, points }
}
