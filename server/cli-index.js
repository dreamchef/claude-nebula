import { build } from './build.js'

let last = 0
const { meta } = await build((p) => {
  const now = Date.now()
  if (now - last < 400 && p.done !== p.total) return
  last = now
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  process.stdout.write(`\r  ${p.phase.padEnd(7)} ${String(pct).padStart(3)}%  ${p.done}/${p.total}   `)
})
process.stdout.write('\n')
console.log(`indexed ${meta.count} points across ${meta.sessions.length} sessions in ${(meta.buildMs / 1000).toFixed(1)}s`)
