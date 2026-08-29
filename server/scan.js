import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { listTranscripts } from './transcripts.js'

const run = promisify(execFile)

const ROLE_PATTERNS = [
  [/\bbg-pty-host\b/, 'pty-host'],
  [/\bbg-spare\b/, 'spare'],
  [/\bdaemon\b/, 'daemon'],
  [/chrome-native-host/, 'chrome-bridge'],
  [/\bmcp\b/, 'mcp'],
]

function classify(cmd) {
  for (const [re, role] of ROLE_PATTERNS) if (re.test(cmd)) return role
  return 'session'
}

/** `12-03:04:05` / `03:04:05` / `04:05` -> seconds */
function parseEtime(s) {
  const [days, clock] = s.includes('-') ? s.split('-') : [null, s]
  const parts = clock.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  return (days ? Number(days) * 86400 : 0) + parts[0] * 3600 + parts[1] * 60 + parts[2]
}

async function cwdOf(pid) {
  try {
    const { stdout } = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: 4000 })
    const line = stdout.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}

/** Every live Claude Code process, annotated with the transcript it is most likely writing. */
export async function scanProcesses() {
  let stdout = ''
  try {
    ;({ stdout } = await run('ps', ['-axo', 'pid=,ppid=,etime=,rss=,command='], { maxBuffer: 32 * 1024 * 1024 }))
  } catch {
    return []
  }

  const procs = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, etime, rss, command] = m
    if (!/(^|\/)claude(\s|$)|\bclaude\s+(bg-|daemon)|Claude\.app/.test(command)) continue
    if (/\bgrep\b|shell-snapshots/.test(command)) continue
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      uptimeSec: parseEtime(etime),
      rssKb: Number(rss),
      role: classify(command),
      command: command.length > 400 ? command.slice(0, 400) + '…' : command,
    })
  }

  const transcripts = listTranscripts()
  const now = Date.now()

  await Promise.all(
    procs.map(async (p) => {
      if (p.role !== 'session') return
      p.cwd = await cwdOf(p.pid)
      if (!p.cwd) return
      // The transcript for a live session is the newest one whose cwd matches.
      const started = now - p.uptimeSec * 1000
      const candidates = transcripts.filter((t) => t.projectPath === p.cwd.replace(/\/$/, ''))
      const best = candidates.filter((t) => t.mtime >= started - 60_000).pop() || candidates.pop()
      if (best) {
        p.sessionId = best.sessionId
        p.project = best.project
        p.transcriptAgeSec = Math.round((now - best.mtime) / 1000)
        p.live = now - best.mtime < 120_000
      }
    })
  )

  return procs.sort((a, b) => a.pid - b.pid)
}

export function projectLabel(projectPath) {
  return path.basename(projectPath) || projectPath
}
