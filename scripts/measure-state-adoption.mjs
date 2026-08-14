#!/usr/bin/env node
/**
 * Measure `state.` usage in DSH run_code programs across session transcripts.
 *
 * Usage:
 *   node measure-state.mjs [sessionsRoot] [--cutoff <ISO8601>] [--dump <dir>]
 *
 * Default sessionsRoot: %USERPROFILE%\.dsh\sessions
 * Default cutoff:       2026-08-14T19:16:41+08:00  (commit f8a2d62)
 */
import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
  else positional.push(argv[i])
}
const ROOT = positional[0] ?? join(homedir(), '.dsh', 'sessions')
const CUTOFF = Date.parse(flags.cutoff ?? '2026-08-14T19:16:41+08:00')
const DUMP = flags.dump

// read/write of the persistent realm binding: `state.x`, `state["x"]`,
// but NOT `this.state.x`, `nextState.x`, `foo.state.x`
const STATE_RE = /(?<![A-Za-z0-9_$.])state\s*(?:\.|\[)/

// DSH writes a CONCATENATED zstd frame container (one frame per append batch).
// Node's one-shot/stream API only yields the first frame, so scan frame
// boundaries (port of dsh-session-persistence-jsonl/src/zstd.ts) and decode each.
const ZSTD_MAGIC = 0xFD2FB528
function scanZstdFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4 || buf.readUInt32LE(off) !== ZSTD_MAGIC) break
    off += 4
    if (off === buf.length) break
    const desc = buf.readUInt8(off); off += 1
    const contentSizeFlag = desc >>> 6
    const singleSegment = (desc & 0x20) !== 0
    const checksum = (desc & 0x04) !== 0
    const dictFlag = desc & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    off += (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes
    if (off > buf.length) break
    let torn = false
    for (;;) {
      if (buf.length - off < 3) { torn = true; break }
      const bh = buf.readUIntLE(off, 3); off += 3
      const last = (bh & 1) !== 0
      const type = (bh >>> 1) & 0x03
      const payload = type === 0x01 ? 1 : bh >>> 3
      if (buf.length - off < payload) { torn = true; break }
      off += payload
      if (last) break
    }
    if (torn) break
    if (checksum) { if (buf.length - off < 4) break; off += 4 }
    frames.push([start, off])
  }
  return frames
}

async function inflate(file) {
  const raw = readFileSync(file)
  if (!file.endsWith('.zstd')) return raw.toString('utf8')
  const out = []
  for (const [s, e] of scanZstdFrames(raw)) out.push(zstdDecompressSync(raw.subarray(s, e)))
  return Buffer.concat(out).toString('utf8')
}

function* walkSessions(root) {
  for (const project of readdirSync(root)) {
    const pdir = join(root, project)
    if (!statSync(pdir).isDirectory()) continue
    for (const sid of readdirSync(pdir)) {
      const sdir = join(pdir, sid)
      if (!statSync(sdir).isDirectory()) continue
      for (const f of readdirSync(sdir)) {
        if (f === 'session.jsonl.zstd' || f === 'session.jsonl') {
          yield { project, sid, file: join(sdir, f) }
        }
      }
    }
  }
}

const sessions = []
for (const s of walkSessions(ROOT)) {
  let text
  try { text = await inflate(s.file) } catch (e) { sessions.push({ ...s, error: String(e) }); continue }
  const lines = text.split('\n').filter(Boolean)
  let header = null
  const programs = []
  for (const line of lines) {
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'session') { header = ev; continue }
    if (ev.type !== 'tool/call') continue
    const d = ev.data ?? {}
    if (d.name !== 'run_code') continue
    let args = d.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
    if (!args || typeof args.code !== 'string') continue
    programs.push({ time: ev.time, callId: d.callId, code: args.code, description: args.description })
  }
  sessions.push({
    ...s,
    // which policy revision the session actually carried (system prompt text)
    policy: text.includes('persists across run_code calls in this session') ? 'f8a2d62+'
      : text.includes('Realm state is the working namespace: assign') ? 'ec4fccb'
        : 'pre-ec4fccb',
    createdAt: header?.createdAt ?? statSync(s.file).mtimeMs,
    origin: header?.origin ?? 'root',
    agentPreset: header?.agentPreset,
    parentSession: header?.parentSession,
    programs,
  })
}

// ---- boilerplate / helper repetition (coarse) ----
function helperNames(code) {
  const names = new Set()
  const re = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g
  let m
  while ((m = re.exec(code))) names.add(m[1] ?? m[2])
  return names
}

function report(label, group) {
  const progs = group.flatMap(s => s.programs)
  const withState = progs.filter(p => STATE_RE.test(p.code))
  const helperCounts = new Map()
  for (const p of progs) for (const n of helperNames(p.code)) helperCounts.set(n, (helperCounts.get(n) ?? 0) + 1)
  const repeated = [...helperCounts.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1])
  console.log(`\n=== ${label} ===`)
  console.log(`sessions:            ${group.length}`)
  console.log(`run_code programs:   ${progs.length}`)
  console.log(`programs w/ state.:  ${withState.length} (${progs.length ? (100 * withState.length / progs.length).toFixed(1) : '0.0'}%)`)
  console.log(`sessions w/ state.:  ${group.filter(s => s.programs.some(p => STATE_RE.test(p.code))).length}`)
  console.log(`repeated helper defs (name x programs, top 15):`)
  console.log('  ' + (repeated.slice(0, 15).map(([n, c]) => `${n}x${c}`).join(', ') || '(none)'))
  if (withState.length && DUMP) {
    mkdirSync(DUMP, { recursive: true })
    withState.forEach((p, i) => writeFileSync(join(DUMP, `${label.replace(/\W+/g, '_')}-${i}-${p.callId?.slice(0, 12) ?? i}.ts`), p.code))
  }
  return { sessions: group.length, programs: progs.length, withState: withState.length }
}

const pre = sessions.filter(s => s.createdAt < CUTOFF)
const post = sessions.filter(s => s.createdAt >= CUTOFF)

console.log(`sessions root: ${ROOT}`)
console.log(`cutoff:        ${new Date(CUTOFF).toISOString()} (${flags.cutoff ?? '2026-08-14T19:16:41+08:00'})`)
console.log(`total session artifacts: ${sessions.length}`)
report('PRE  f8a2d62', pre)
report('POST f8a2d62', post)

// Confound control: the policy text a session ACTUALLY carried, plus preset.
console.log('\n=== cohort by policy text actually present in the transcript ===')
const byPolicy = new Map()
for (const s of sessions) {
  const key = `${s.policy} | preset=${s.agentPreset ?? '(none)'} | ${s.createdAt < CUTOFF ? 'PRE ' : 'POST'}`
  const g = byPolicy.get(key) ?? { sessions: 0, progs: 0, state: 0 }
  g.sessions++
  g.progs += s.programs?.length ?? 0
  g.state += s.programs?.filter(p => STATE_RE.test(p.code)).length ?? 0
  byPolicy.set(key, g)
}
for (const [k, g] of [...byPolicy].sort()) {
  console.log(`  ${k.padEnd(46)} sessions=${g.sessions} progs=${g.progs} state=${g.state} (${g.progs ? (100 * g.state / g.progs).toFixed(1) : '0.0'}%)`)
}

console.log('\n--- per-session detail (createdAt, side, policy, preset, project, id, programs, withState) ---')
for (const s of sessions.sort((a, b) => a.createdAt - b.createdAt)) {
  const w = s.programs?.filter(p => STATE_RE.test(p.code)).length ?? 0
  console.log(
    [new Date(s.createdAt).toISOString(), s.createdAt < CUTOFF ? 'PRE ' : 'POST',
      s.policy.padEnd(11), (s.agentPreset ?? '-').padEnd(8),
      s.project, basename(s.sid).slice(0, 12), `progs=${String(s.programs?.length ?? 'ERR').padStart(3)}`,
      `state=${w}`, s.origin].join('  '),
  )
}
