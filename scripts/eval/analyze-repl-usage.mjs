#!/usr/bin/env node
// Diagnostic: how do models actually use the Prime `repl` cell in real DSH sessions?
// Read-only over ~/.dsh/sessions/**/session.jsonl.zstd (multi-frame zstd JSONL).
//
// Usage:
//   node scripts/eval/analyze-repl-usage.mjs [--samples N] [--classes a,b] [--model substr] [--out report.json] [--probe]
//
// Per provider/model it reports cell classes (single-call-echo / single-call-processed /
// multi-call-composed / compute-only / no-dispatch), in-program reduction (model-visible chars vs
// raw nested tool-output chars), declared-name reuse across cells, `$_` usage, spill rate,
// cells per turn, visible chars per turn, and compaction/prune event counts.
// Background and the 2026-09-04 baseline: docs/research/2026-code-mode-context-engineering.zh.md.

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { zstdDecompressSync } from 'node:zlib'

const args = new Map(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(Boolean))
const sessionsRoot = path.join(homedir(), '.dsh', 'sessions')
const probe = args.get('probe') === true
const samples = Number(args.get('samples') ?? 6)
const out = args.get('out')

const sessions = []
for await (const file of sessionFiles(sessionsRoot)) {
  try {
    const s = await analyze(file)
    if (s) sessions.push(s)
  } catch (e) {
    console.error(`warn ${file}: ${e.message}`)
  }
}

const report = aggregate(sessions)
if (out) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(out, JSON.stringify({ report, sessions: sessions.map(s => ({ ...s, cells: s.cells.map(c => ({ ...c, code: undefined })) })) }, null, 2))
}
printHuman(report, sessions)

// ---------------------------------------------------------------------------

async function analyze(file) {
  let cwd, provider, model
  const calls = new Map()      // callId -> { name, code, time }
  const cells = []             // repl cells in order
  const dispatches = new Map() // parentCallId -> [{name, bytes, isError}]
  const declared = new Set()   // names declared so far in this session (approx.)
  const seenDispatch = new Set()
  let turns = 0, compactions = 0, prunes = 0, compactionErrors = 0
  let anyRepl = false
  let probeShown = { call: 0, result: 0, dispatch: 0 }
  let createdAt

  for await (const ev of readEvents(file)) {
    const type = ev.type
    const data = isRecord(ev.data) ? ev.data : {}
    if (type === 'session') { cwd = ev.cwd; createdAt = ev.createdAt ?? ev.time }
    if (type === 'request/context') {
      if (typeof data.provider === 'string') provider = data.provider
      if (typeof data.model === 'string') model = data.model
    }
    if (type === 'turn/end') turns += 1
    if (type === 'compaction/summary') compactions += 1
    if (type === 'compaction/prune') prunes += 1
    if (type === 'compaction/end' && typeof data.error === 'string') compactionErrors += 1
    if (type === 'tool/call' && typeof data.callId === 'string') {
      let argsObj = data.arguments ?? data.args ?? data.input ?? data.params
      if (typeof argsObj === 'string') { try { argsObj = JSON.parse(argsObj) } catch { argsObj = undefined } }
      const code = isRecord(argsObj) && typeof argsObj.code === 'string' ? argsObj.code : undefined
      calls.set(data.callId, { name: data.name, code, time: ev.time ?? ev.time0 })
      if (probe && probeShown.call < 1 && data.name === 'repl') { probeShown.call++; console.error('PROBE tool/call keys:', Object.keys(data), 'argsKeys:', isRecord(argsObj) ? Object.keys(argsObj) : typeof argsObj) }
      if (data.name === 'repl') anyRepl = true
      continue
    }
    if (type === 'tool/code-dispatch') {
      const parent = data.parentCallId
      if (typeof parent !== 'string') continue
      const list = dispatches.get(parent) ?? []
      const sig = `${data.name}:${JSON.stringify(data.arguments ?? null)}`
      const repeated = seenDispatch.has(sig)
      seenDispatch.add(sig)
      const a = isRecord(data.arguments) ? data.arguments : {}
      list.push({ name: data.name, bytes: textBytes(data.content), isError: data.isError === true, repeated, rangedRead: data.name === 'read' && (a.offset !== undefined || a.limit !== undefined) })
      dispatches.set(parent, list)
      if (probe && probeShown.dispatch < 1) { probeShown.dispatch++; console.error('PROBE code-dispatch keys:', Object.keys(data)) }
      continue
    }
    if (type === 'tool/result') {
      const callId = isRecord(data.message) && isRecord(data.message.source) ? data.message.source.callId : data.callId
      const call = typeof callId === 'string' ? calls.get(callId) : undefined
      if (probe && probeShown.result < 1 && call?.name === 'repl') { probeShown.result++; console.error('PROBE tool/result keys:', Object.keys(data), 'message keys:', isRecord(data.message) ? Object.keys(data.message) : '-') }
      if (!call || call.name !== 'repl' || call.code === undefined) continue
      const text = collectText(data).join('\n')
      const nested = dispatches.get(callId) ?? []
      const f = features(call.code, declared)
      for (const n of f.declares) declared.add(n)
      cells.push({
        callId,
        time: ev.time ?? ev.time0,
        code: call.code,
        codeChars: call.code.length,
        nestedCalls: nested.length,
        nestedTools: [...new Set(nested.map(n => n.name))],
        nestedBytes: nested.reduce((a, n) => a + n.bytes, 0),
        nestedErrors: nested.filter(n => n.isError).length,
        repeatedDispatches: nested.filter(n => n.repeated).length,
        reads: nested.filter(n => n.name === 'read').length,
        rangedReads: nested.filter(n => n.rangedRead).length,
        resultChars: text.length,
        isError: /repl cell failed|^Error:/m.test(text),
        spilled: /Full formatted result stored at|stored at:/i.test(text),
        retainedPreview: /remains in this REPL as `\$_`/.test(text),
        ...f,
      })
    }
  }
  if (!anyRepl || cells.length === 0) return undefined
  // declared-name reuse: for each name declared in cell i, is it referenced in any later cell?
  let declaredTotal = 0, declaredReused = 0
  for (let i = 0; i < cells.length; i++) {
    for (const n of cells[i].declares) {
      declaredTotal++
      const re = new RegExp(`(?<![\\w$.])${escapeRe(n)}(?![\\w$])`)
      if (cells.slice(i + 1).some(c => re.test(c.code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""')) && !c.declares.includes(n))) declaredReused++
    }
  }
  return { file: path.relative(sessionsRoot, file), cwd, provider, model, createdAt, turns, compactions, prunes, compactionErrors, cells, declaredTotal, declaredReused }
}

function features(code, declaredBefore) {
  const declares = new Set()
  for (const m of code.matchAll(/^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm)) declares.add(m[1])
  for (const m of code.matchAll(/^\s*(?:let|const|var)\s*\{([^}]*)\}/gm)) for (const n of m[1].split(',')) { const id = n.split(':').pop().trim().split('=')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(id)) declares.add(id) }
  for (const m of code.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) declares.add(m[1])
  const stripped = code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""') // crude: drop string literals
  const reusesPrior = [...declaredBefore].some(n => !declares.has(n) && new RegExp(`(?<![\\w$.])${escapeRe(n)}(?![\\w$])`).test(stripped))
  const awaitTools = (code.match(/tools\.[A-Za-z_]+\s*\(/g) ?? []).length
  const agentsCalls = (code.match(/agents\.[A-Za-z_]+\s*\(/g) ?? []).length
  const jobsCalls = (code.match(/jobs\.[A-Za-z_]+\s*\(/g) ?? []).length
  return {
    declares: [...declares],
    declaresCount: declares.size,
    reusesPrior,
    usesLastResult: /(?<![\w$])\$_(?![\w$])/.test(stripped),
    toolCallSites: awaitTools,
    agentsCalls,
    jobsCalls,
    usesReduce: /\.(filter|map|reduce|slice|find|some|every|flatMap|join|split|match|matchAll|includes|indexOf|substring|test)\s*\(/.test(code),
    usesLoop: /\b(for|while)\s*\(|\.forEach\s*\(/.test(code),
    usesParallel: /Promise\.(all|allSettled|race)\b/.test(code),
    definesFn: /\b(function\s+\w+|=>)/.test(code),
    usesLog: /console\.(log|error|info|warn)\s*\(/.test(code),
    usesStringify: /JSON\.stringify\s*\(/.test(code),
    usesTry: /\btry\s*\{/.test(code),
    endsWithRawToolCall: /(?:^|\n)\s*(?:await\s+)?tools\.[A-Za-z_]+\s*\([^]*\)\s*;?\s*$/.test(code.trim()) && !/\n\s*(let|const|var)\b[^]*$/.test(code.trim().split('\n').slice(-1)[0]),
  }
}

function classify(c) {
  if (c.nestedCalls === 0) return c.toolCallSites === 0 ? 'compute-only' : 'no-dispatch'
  if (c.nestedCalls === 1 && !c.usesReduce && !c.usesLoop && !c.definesFn) return 'single-call-echo'
  if (c.nestedCalls === 1) return 'single-call-processed'
  if (c.usesReduce || c.usesLoop || c.definesFn || c.usesParallel) return 'multi-call-composed'
  return 'multi-call-plain'
}

function aggregate(sessions) {
  const all = sessions.flatMap(s => s.cells.map(c => ({ ...c, model: s.model ?? 'unknown', provider: s.provider ?? '?', session: s.file })))
  const byModel = new Map()
  const sessionAgg = new Map()
  for (const s of sessions) {
    const key = `${s.provider ?? '?'}/${s.model ?? 'unknown'}`
    const a = sessionAgg.get(key) ?? { turns: 0, cells: 0, declaredTotal: 0, declaredReused: 0, resultChars: 0, compactions: 0, prunes: 0, compactionErrors: 0, sessionsWithCompaction: 0 }
    a.turns += s.turns; a.cells += s.cells.length; a.declaredTotal += s.declaredTotal; a.declaredReused += s.declaredReused
    a.compactions += s.compactions; a.prunes += s.prunes; a.compactionErrors += s.compactionErrors; if (s.compactions > 0) a.sessionsWithCompaction++
    a.resultChars += s.cells.reduce((x, c) => x + c.resultChars, 0)
    sessionAgg.set(key, a)
  }
  for (const c of all) {
    const key = `${c.provider}/${c.model}`
    const g = byModel.get(key) ?? { cells: 0, classes: {}, bytesByClass: {}, resultChars: [], nestedCalls: [], reusesPrior: 0, usesLastResult: 0, declares: 0, spilled: 0, errors: 0, parallel: 0, agents: 0, jobs: 0, tools: {}, dispatches: 0, repeated: 0, reads: 0, rangedReads: 0, noDispatchErrors: 0, largeEcho: 0, sessions: new Set(), turns: 0 }
    g.cells++
    g.sessions.add(c.session)
    const k = classify(c); g.classes[k] = (g.classes[k] ?? 0) + 1
    g.bytesByClass[k] = (g.bytesByClass[k] ?? 0) + c.resultChars
    g.dispatches += c.nestedCalls; g.repeated += c.repeatedDispatches; g.reads += c.reads; g.rangedReads += c.rangedReads
    if (k === 'no-dispatch' && c.isError) g.noDispatchErrors++
    if (k === 'single-call-echo' && c.resultChars >= 8000) g.largeEcho++
    if (c.nestedCalls > 0 && c.nestedBytes > 0 && !c.isError) {
      g.ratioCells = (g.ratioCells ?? 0) + 1
      const ratio = c.resultChars / c.nestedBytes
      if (ratio <= 0.5) g.reduced = (g.reduced ?? 0) + 1
      if (ratio >= 0.9) g.unreduced = (g.unreduced ?? 0) + 1
      if (c.nestedBytes >= 4000) { g.bigCells = (g.bigCells ?? 0) + 1; if (ratio <= 0.5) g.bigReduced = (g.bigReduced ?? 0) + 1 }
    }
    g.resultChars.push(c.resultChars); g.nestedCalls.push(c.nestedCalls)
    if (c.reusesPrior) g.reusesPrior++
    if (c.usesLastResult) g.usesLastResult++
    if (c.declaresCount > 0) g.declares++
    if (c.spilled) g.spilled++
    if (c.isError) g.errors++
    if (c.usesParallel) g.parallel++
    if (c.agentsCalls > 0) g.agents++
    if (c.jobsCalls > 0) g.jobs++
    for (const t of c.nestedTools) g.tools[t] = (g.tools[t] ?? 0) + 1
    byModel.set(key, g)
  }
  const summary = {}
  for (const [key, g] of byModel) {
    const totalBytes = Object.values(g.bytesByClass).reduce((a, b) => a + b, 0)
    const sa = sessionAgg.get(key)
    summary[key] = {
      sessions: g.sessions.size,
      cells: g.cells,
      cellsPerTurn: sa && sa.turns > 0 ? (sa.cells / sa.turns).toFixed(2) : 'n/a',
      resultCharsPerTurn: sa && sa.turns > 0 ? Math.round(sa.resultChars / sa.turns) : 'n/a',
      declaredNamesReusedLater: sa ? `${sa.declaredReused}/${sa.declaredTotal} (${pct(sa.declaredReused, sa.declaredTotal)})` : 'n/a',
      compaction: sa ? `summaries ${sa.compactions} in ${sa.sessionsWithCompaction}/${g.sessions.size} sessions; prune replacements ${sa.prunes}; failed compactions ${sa.compactionErrors}` : 'n/a',
      inProgramReduction: `cells with dispatch: ${g.ratioCells ?? 0}; visible<=50% of raw: ${pct(g.reduced ?? 0, g.ratioCells ?? 0)}; visible>=90% of raw: ${pct(g.unreduced ?? 0, g.ratioCells ?? 0)}; raw>=4k cells: ${g.bigCells ?? 0}, of which reduced<=50%: ${pct(g.bigReduced ?? 0, g.bigCells ?? 0)}`,
      classes: Object.fromEntries(Object.entries(g.classes).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${v} (${pct(v, g.cells)})`])),
      resultBytesShareByClass: Object.fromEntries(Object.entries(g.bytesByClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v, totalBytes)])),
      repeatedIdenticalDispatch: `${g.repeated}/${g.dispatches} (${pct(g.repeated, g.dispatches)})`,
      rangedReads: `${g.rangedReads}/${g.reads} (${pct(g.rangedReads, g.reads)})`,
      noDispatchThatErrored: `${g.noDispatchErrors}/${g.classes['no-dispatch'] ?? 0}`,
      largeEchoCells: `${g.largeEcho} (>=8k chars, ${pct(g.largeEcho, g.cells)} of cells)`,
      reusesPriorBinding: pct(g.reusesPrior, g.cells),
      usesLastResult: pct(g.usesLastResult, g.cells),
      declaresSomething: pct(g.declares, g.cells),
      usesPromiseAll: pct(g.parallel, g.cells),
      usesAgents: pct(g.agents, g.cells),
      usesJobs: pct(g.jobs, g.cells),
      spilled: pct(g.spilled, g.cells),
      cellErrors: pct(g.errors, g.cells),
      resultChars: stats(g.resultChars),
      nestedCallsPerCell: stats(g.nestedCalls),
      topTools: Object.entries(g.tools).sort((a, b) => b[1] - a[1]).slice(0, 10),
    }
  }
  return { sessions: sessions.length, cells: all.length, byModel: summary }
}

function printHuman(report, sessions) {
  console.log(`Prime sessions with repl cells: ${report.sessions}; cells: ${report.cells}`)
  for (const [k, v] of Object.entries(report.byModel)) {
    console.log(`\n== ${k} (${v.sessions} sessions, ${v.cells} cells)`)
    console.log('  classes:', JSON.stringify(v.classes))
    console.log('  resultBytesShareByClass:', JSON.stringify(v.resultBytesShareByClass))
    console.log(`  repeatedIdenticalDispatch ${v.repeatedIdenticalDispatch}  rangedReads ${v.rangedReads}  noDispatchThatErrored ${v.noDispatchThatErrored}  largeEchoCells ${v.largeEchoCells}`)
    console.log(`  cellsPerTurn ${v.cellsPerTurn}  resultCharsPerTurn ${v.resultCharsPerTurn}  declaredNamesReusedLater ${v.declaredNamesReusedLater}`)
    console.log(`  inProgramReduction: ${v.inProgramReduction}`)
    console.log(`  compaction: ${v.compaction}`)
    console.log(`  reusesPriorBinding ${v.reusesPriorBinding}  usesLastResult($_) ${v.usesLastResult}  declaresSomething ${v.declaresSomething}  Promise.all* ${v.usesPromiseAll}  agents ${v.usesAgents}  jobs ${v.usesJobs}`)
    console.log(`  spilled ${v.spilled}  cellErrors ${v.cellErrors}`)
    console.log('  resultChars:', JSON.stringify(v.resultChars))
    console.log('  nestedCalls/cell:', JSON.stringify(v.nestedCallsPerCell))
    console.log('  topTools:', JSON.stringify(v.topTools))
  }
  if (samples > 0) {
    const all = sessions.flatMap(s => s.cells.map(c => ({ ...c, model: s.model, session: s.file })))
    const onlyModel = args.get('model')
    for (const cls of (args.get('classes') ? String(args.get('classes')).split(',') : ['single-call-echo', 'multi-call-composed', 'compute-only'])) {
      const pick = all.filter(c => classify(c) === cls && (!onlyModel || String(c.model).includes(onlyModel))).sort(() => Math.random() - 0.5).slice(0, samples)
      console.log(`\n--- samples: ${cls} (${pick.length})`)
      for (const c of pick) {
        console.log(`[${c.model}] nested=${c.nestedCalls} result=${c.resultChars}ch reuse=${c.reusesPrior}\n${indent(truncate(c.code, 420))}`)
      }
    }
  }
}

// helpers ---------------------------------------------------------------------
function pct(n, d) { return d === 0 ? '0%' : `${(100 * n / d).toFixed(0)}%` }
function stats(arr) {
  if (arr.length === 0) return {}
  const s = [...arr].sort((a, b) => a - b)
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length), p50: q(0.5), p90: q(0.9), max: s[s.length - 1], sum: s.reduce((a, b) => a + b, 0) }
}
function truncate(s, n) { return s.length <= n ? s : s.slice(0, n) + ' …' }
function indent(s) { return s.split('\n').map(l => '    ' + l).join('\n') }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function textBytes(content) { return collectText({ content }).reduce((a, t) => a + t.length, 0) }
function collectText(value) { const t = []; (function v(c) { if (Array.isArray(c)) return c.forEach(v); if (!isRecord(c)) return; if (typeof c.text === 'string') t.push(c.text); for (const [k, x] of Object.entries(c)) if (k !== 'text') v(x) })(value); return t }
function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

async function* sessionFiles(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* sessionFiles(p)
    else if (e.isFile() && e.name === 'session.jsonl.zstd') yield p
  }
}

async function* readEvents(file) {
  const source = await readFile(file)
  for (const frame of scanZstdFrames(source)) {
    const text = zstdDecompressSync(source.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      try { const ev = JSON.parse(line); if (isRecord(ev)) yield ev } catch {}
    }
  }
}

function scanZstdFrames(source) {
  const frames = []
  let offset = 0
  while (offset < source.length) {
    const start = offset
    if (source.length - offset < 4) break
    if (source.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`invalid frame magic at ${offset}`)
    offset += 4
    if (offset === source.length) break
    const d = source.readUInt8(offset); offset += 1
    const contentSizeFlag = d >>> 6, single = (d & 0x20) !== 0, checksum = (d & 0x04) !== 0, dictFlag = d & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const csBytes = contentSizeFlag === 0 ? (single ? 1 : 0) : 1 << contentSizeFlag
    const rem = (single ? 0 : 1) + dictBytes + csBytes
    if (source.length - offset < rem) break
    offset += rem
    let ok = true
    for (;;) {
      if (source.length - offset < 3) { ok = false; break }
      const bh = source.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3
      const payload = bt === 1 ? 1 : bs
      if (source.length - offset < payload) { ok = false; break }
      offset += payload
      if (last) break
    }
    if (!ok) break
    if (checksum) { if (source.length - offset < 4) break; offset += 4 }
    frames.push({ start, end: offset })
  }
  return frames
}
