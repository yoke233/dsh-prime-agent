/**
 * Phase 1.3 acceptance for the large tool-output plan
 * (`docs/plan/large-tool-output-optimization.md`), migrated to the sole
 * model-visible `repl` transport: the Prime persistent realm composed with the
 * harness output-governance chain (`ctx.spillStore` + `dsh-spill-policy`),
 * driven through the REAL `repl` tool with no model in the loop.
 *
 * What these tests own is the COMPOSITION, not the spill mechanics: the harness
 * already unit-tests retention, locator naming and every best-effort fallback.
 * Here we prove the five properties that only appear once a persistent realm
 * sits behind the bridge — the program keeps the whole canonical value while
 * the model-facing content shrinks, the recovered artifact is the renderer's
 * own text, the realm survives a spill with its live bindings intact, and
 * neither the hard `maxOutputBytes` failure nor a refusing backend is papered
 * over.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

const signal = new AbortController().signal

/** The model-facing cap every test in this file composes the policy with. */
const MAX_INLINE_BYTES = 1024

/** Deterministic single-byte row payload. */
const ASCII_PAYLOAD = 'payload'.repeat(6)
/** Deterministic payload spanning 2-, 3- and 4-byte UTF-8 sequences. */
const UNICODE_PAYLOAD = 'é中😀'.repeat(8)

/** The stub backend's fixed locator/hint, so a notice's byte cost is computable in advance. */
const STUB_LOCATOR = '/stub/spill.txt'
const STUB_HINT = 'Stub retrieval.'

let ctx: Context | undefined
let root: string | undefined
let callNumber = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callNumber = 0
  vi.restoreAllMocks()
})

/** One session event the fixture agent recorded, with its type. */
interface LoggedEvent {
  type: string
  data: unknown
}

/** The synthetic tool's canonical value: a structured DTO, never a formatted string. */
interface Report {
  marker: string
  rows: string[]
}

/** The exact rows `big_report` produces for a given request — recomputed test-side as the oracle. */
function reportRows(count: number, unicode: boolean): string[] {
  const payload = unicode ? UNICODE_PAYLOAD : ASCII_PAYLOAD
  const rows: string[] = []
  for (let index = 0; index < count; index++) rows.push(`row-${String(index).padStart(4, '0')}: ${payload}`)
  return rows
}

/** The tool renderer's final formatted text — the exact bytes a spill artifact must hold. */
function renderReport(value: Report): string {
  return [`REPORT ${value.marker}`, ...value.rows, `END ${value.marker}`].join('\n')
}

/**
 * A tool with a STRUCTURED canonical value and a text renderer: the program
 * receives `{ marker, rows }`, while the model/log projection is `renderReport`.
 */
const bigReportTool = defineTool({
  name: 'big_report',
  description: 'Return a deterministic multi-row report as a structured value.',
  parameters: {
    rows: { type: 'integer', required: true, description: 'How many rows to produce.' },
    marker: { type: 'string', description: 'Report marker.' },
    unicode: { type: 'boolean', description: 'Use a multi-byte row payload.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: renderReport(value as unknown as Report) }],
  },
  async execute(args): Promise<JsonValue> {
    return {
      marker: args.marker ?? 'ALPHA',
      rows: reportRows(args.rows, args.unicode ?? false),
    }
  },
})

/** A tool echoing exactly the bytes it was given — byte-exact cap-boundary control. */
const echoTextTool = defineTool({
  name: 'echo_text',
  description: 'Echo the supplied text verbatim.',
  parameters: { text: { type: 'string', required: true, description: 'Text to echo.' } },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
  },
  async execute(args): Promise<JsonValue> {
    return { text: args.text }
  },
})

/** A spill backend with a fixed locator; `fail` exercises the best-effort degradation. */
class StubSpillStore extends SpillStore {
  saves: SaveTextSpill[] = []
  fail = false

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fail) throw new Error('spill backend unavailable')
    this.saves.push(input)
    return {
      locator: SpillLocator(STUB_LOCATOR),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: STUB_HINT,
    }
  }
}

/** The notice the policy composes for a fully-omitted body against {@link StubSpillStore}. */
function stubNotice(omittedBytes: number): string {
  return `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${STUB_LOCATOR}. ${STUB_HINT})`
}

function testAgent(id: string, cwd: string, events: LoggedEvent[]): Agent {
  return {
    id: SessionId(id),
    session: {
      // `header.id` is the spill owner the policy reads; `append` is the durable log.
      header: { id: SessionId(id), cwd },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
}

interface BootOptions {
  /** Which spill backend to mount. */
  backend: 'local' | 'stub' | 'failing'
  /** The policy cap; defaults to {@link MAX_INLINE_BYTES}. */
  maxInlineBytes?: number
  /** Prime's hard outer-output cap; omitted keeps the official default. */
  maxOutputBytes?: number
}

interface Booted {
  context: Context
  store: StubSpillStore | undefined
  spillRoot: string
  events: LoggedEvent[]
  agent: Agent
}

/** Boot the real composition: system prompt, native tools, a spill backend, the policy, Prime. */
async function bootPrime(options: BootOptions): Promise<Booted> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prime-large-output-'))
  const stateDirectory = join(root, 'state')
  const spillRoot = join(root, 'spill')
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)

  let store: StubSpillStore | undefined
  if (options.backend === 'local') {
    await context.plugin(LocalSpillStore, { root: spillRoot })
  } else {
    await context.plugin(StubSpillStore)
    store = context.spillStore as StubSpillStore
    store.fail = options.backend === 'failing'
  }

  await context.plugin(SpillPolicy, { maxInlineBytes: options.maxInlineBytes ?? MAX_INLINE_BYTES })
  await context.plugin(primeRuntime, {
    stateDirectory,
    ...options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {},
  })
  await context.plugin(primeAgent, { stateDirectory })
  context.tools.register(bigReportTool)
  context.tools.register(echoTextTool)

  ctx = context
  const events: LoggedEvent[] = []
  return { context, store, spillRoot, events, agent: testAgent('prime-large-output', root, events) }
}

async function runRepl(agent: Agent, code: string): Promise<ToolExecutionResult> {
  if (ctx === undefined) throw new Error('test context was not created')
  return await ctx.tools.execute({
    callId: CallId(`prime-large-output-${++callNumber}`),
    name: 'repl',
    arguments: { code },
    signal,
    agent,
  })
}

/** The run's canonical `repl` value (logs plus the optional completion), asserting success. */
function runValue(result: ToolExecutionResult): { logs: string[]; result?: JsonValue } {
  if (result.isError) throw new Error(`expected success, got: ${result.error.message}`)
  const value = result.value as { logs: string[]; result?: JsonValue }
  return value
}

function textOf(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text).join('')
}

/** The `repl` renderer's own formatting rule, recomputed from the canonical value. */
function renderRepl(value: { logs: string[]; result?: JsonValue }): string {
  return JSON.stringify(value)
}

/** Pull the opaque locator back out of a notice, exactly as a reader would. */
function locatorOf(text: string): string {
  const match = /Full formatted result stored at: (.+?)\. Use read with/.exec(text)
  if (match?.[1] === undefined) throw new Error(`no spill locator in: ${text.slice(-300)}`)
  return match[1]
}

/** Every file the local backend wrote under `spillRoot` (empty when it wrote nothing). */
async function spillFiles(spillRoot: string): Promise<string[]> {
  let sessions: string[]
  try {
    sessions = await readdir(spillRoot)
  } catch {
    return []
  }
  const files: string[] = []
  for (const session of sessions) {
    for (const entry of await readdir(join(spillRoot, session))) files.push(join(spillRoot, session, entry))
  }
  return files
}

describe('scenario 1: nested full value, bounded model-facing content, retained live binding', () => {
  it('gives the program the whole canonical value while the model-facing content keeps only a preview and locator', async () => {
    const { spillRoot, events, agent } = await bootPrime({ backend: 'local' })
    const expectedRows = reportRows(300, false)
    const expectedChars = expectedRows.reduce((total, row) => total + row.length, 0)

    const first = await runRepl(agent, `
      const report = await tools.big_report({ rows: 300, marker: 'ALPHA' })
      const summary = {
        rows: report.rows.length,
        chars: report.rows.reduce((total, row) => total + row.length, 0),
        first: report.rows[0],
        last: report.rows[report.rows.length - 1],
      }
      ;({ ...summary, text: report.rows.join('\\n') })
    `)

    // The program computed over the COMPLETE structured value: a truncated or
    // locator-substituted binding could not reproduce these two numbers.
    const firstValue = runValue(first)
    expect(firstValue.result).toMatchObject({
      rows: 300,
      chars: expectedChars,
      first: expectedRows[0],
      last: expectedRows[299],
    })

    // The model-facing copy is bounded, carries the locator, and drops the body.
    const content = textOf(first.content)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MAX_INLINE_BYTES)
    expect(content).toContain('Full formatted result stored at:')
    expect(content).toContain('Omitted')
    expect(content).not.toContain('row-0150')

    // The artifact is the RENDERER's text, byte for byte — not a DTO re-serialization.
    const expectedText = JSON.stringify(firstValue)
    const recovered = await readFile(locatorOf(content), 'utf8')
    expect(recovered).toBe(expectedText)
    expect(Buffer.byteLength(recovered, 'utf8')).toBe(Buffer.byteLength(expectedText, 'utf8'))

    // Exactly one artifact: the small outer result was never spilled as well.
    expect(await spillFiles(spillRoot)).toHaveLength(1)

    // The realm survived the spill: the reduced live binding is readable next run.
    const second = await runRepl(agent, 'summary')
    const secondValue = runValue(second)
    expect(secondValue.result).toEqual({
      rows: 300,
      chars: expectedChars,
      first: expectedRows[0],
      last: expectedRows[299],
    })

    // No handshake/bootstrap or code-dispatch projection reached the session log.
    expect(events).toEqual([])
  })
})

describe('scenario 2: oversized outer completion', () => {
  it('keeps the execution-local canonical value whole while bounding the model-facing content', async () => {
    const { spillRoot, events, agent } = await bootPrime({ backend: 'local' })
    const body = 'OUTER-'.repeat(1000)

    const execution = await runRepl(agent, `"OUTER-".repeat(1000)`)
    const value = runValue(execution)

    // Execution-local canonical value: complete, untouched by the presentation policy.
    expect(value.result).toBe(body)

    // Model-facing content: bounded preview plus locator.
    const content = textOf(execution.content)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MAX_INLINE_BYTES)
    expect(content).not.toBe(renderRepl(value))
    expect(content).toContain('Full formatted result stored at:')

    // The locator recovers the repl renderer's complete formatted text.
    const recovered = await readFile(locatorOf(content), 'utf8')
    expect(recovered).toBe(renderRepl(value))
    expect(recovered).toContain(body)
    expect(await spillFiles(spillRoot)).toHaveLength(1)

    // This fixture has no agent loop, so it must not pretend a durable outer
    // `tool/result` was committed; the bridge appends no dispatch projections.
    expect(events.map(event => event.type).filter(type => type.startsWith('tool/result'))).toEqual([])
    expect(events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })
})

describe('scenario 3: the hard output cap references instead of failing', () => {
  it('answers a completion past maxOutputBytes with a bounded reference, and spills no artifact', async () => {
    const { spillRoot, agent } = await bootPrime({ backend: 'local', maxOutputBytes: 1024 })

    const execution = await runRepl(agent, `"Z".repeat(2000)`)

    expect(execution.isError).toBe(false)
    const envelope = runValue(execution).result as Record<string, unknown>
    expect(envelope).toMatchObject({ retained: true, type: 'string', serializedBytesAtCapture: 2002, truncated: true })
    expect(envelope.use).toBe(`$out(${String(envelope.$out)})`)
    // The reference is bounded, so it fits the wire whole and nothing was
    // spilled — the presentation policy never sees a payload worth an artifact.
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(512)
    expect(await spillFiles(spillRoot)).toHaveLength(0)
    expect(textOf(execution.content)).not.toContain('Full formatted result stored at:')

    // And the value the reference names is still there, in full, for the next cell.
    const recovered = await runRepl(agent, `$out(${String(envelope.$out)}).length`)
    expect(runValue(recovered).result).toBe(2000)
  })
})

describe('scenario 4: UTF-8 and cap boundaries', () => {
  it('carries 2/3/4-byte text through the realm intact and cuts the preview on code points', async () => {
    const { agent } = await bootPrime({ backend: 'local' })
    const expectedRows = reportRows(60, true)

    const execution = await runRepl(agent, `
      const report = await tools.big_report({ rows: 60, marker: 'UNI', unicode: true })
      const joined = report.rows.join('')
      ;({ rows: report.rows.length, units: joined.length, points: [...joined].length, text: joined })
    `)

    const joined = expectedRows.join('')
    const value = runValue(execution)
    expect(value.result).toMatchObject({
      rows: 60,
      units: joined.length,
      points: [...joined].length,
    })
    expect((value.result as { text: string }).text).toBe(joined)

    const fullText = renderRepl(value)
    const content = textOf(execution.content)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MAX_INLINE_BYTES)
    expect(content).toContain('Full formatted result stored at:')
    // No replacement character was introduced by either cut.
    expect(content).not.toContain('�')

    const preview = content.slice(0, content.lastIndexOf('\n\n(Omitted'))
    expect(preview.length).toBeGreaterThan(40)
    expect(fullText.startsWith(preview.slice(0, 20))).toBe(true)
    expect(fullText.endsWith(preview.slice(-20))).toBe(true)

    // The artifact still holds every byte the renderer produced, and none of
    // the multi-byte sequences were damaged in the round trip.
    const artifact = await readFile(locatorOf(content), 'utf8')
    expect(artifact).toBe(fullText)
    expect(artifact).not.toContain('�')
  })

  // Cap-boundary checks run through the OUTER repl content: the nested echo
  // returns a full canonical value to the program, and only the model-facing
  // render of the cell result is governed by the policy cap.
  it('emits a replacement exactly equal to the cap, and keeps the text inline one byte below it', async () => {
    const body = 'x'.repeat(500)
    const echoProgram = `
      const echoed = await tools.echo_text({ text: 'x'.repeat(500) })
      echoed.text
    `
    // The renderer's full text for the cell result: JSON of { logs, result }.
    // The FIRST run of a fresh realm carries the namespace notice in `logs`, so
    // probe the real composition once and measure the render it actually makes.
    const probe = await bootPrime({ backend: 'stub' })
    const probeRun = await runRepl(probe.agent, echoProgram)
    expect(runValue(probeRun).result).toBe(body)
    const full = JSON.stringify(runValue(probeRun))
    const cap = Buffer.byteLength(stubNotice(Buffer.byteLength(full, 'utf8')), 'utf8')

    await ctx?.fiber.dispose()
    ctx = undefined
    await rm(root as string, { recursive: true, force: true })
    root = undefined

    // Reserving the notice leaves a zero-byte preview budget, so the whole body
    // is omitted and the replacement IS the notice — exactly maxInlineBytes.
    const exact = await bootPrime({ backend: 'stub', maxInlineBytes: cap })
    const atCap = await runRepl(exact.agent, echoProgram)
    expect(runValue(atCap).result).toBe(body)
    const replaced = textOf(atCap.content)
    expect(replaced).toBe(stubNotice(Buffer.byteLength(full, 'utf8')))
    expect(Buffer.byteLength(replaced, 'utf8')).toBe(cap)
    expect(exact.store?.saves.map(save => save.content)).toEqual([full])

    await ctx?.fiber.dispose()
    ctx = undefined
    await rm(root as string, { recursive: true, force: true })
    root = undefined

    // One byte less and there is no within-cap replacement: the policy must keep
    // the inline text rather than emit content over the advertised cap.
    const tight = await bootPrime({ backend: 'stub', maxInlineBytes: cap - 1 })
    const warn = vi.spyOn(tight.context.logger, 'warn').mockImplementation(() => {})
    const inline = await runRepl(tight.agent, echoProgram)
    expect(runValue(inline).result).toBe(body)
    expect(textOf(inline.content)).toBe(full)
    // The save happens before the cap check, so the file is a documented
    // harmless orphan — what matters is that no locator reached the content.
    expect(tight.store?.saves).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds maxInlineBytes'))
  })

  it('creates no artifact for empty text or for text exactly at the cap', async () => {
    const { store, events, agent } = await bootPrime({ backend: 'stub', maxInlineBytes: 100 })

    const empty = await runRepl(agent, `
      const echoed = await tools.echo_text({ text: '' })
      echoed.text.length
    `)
    expect(runValue(empty).result).toBe(0)

    // The outer render stays under the cap, so nothing is ever spilled for it.
    const atCap = await runRepl(agent, `
      const echoed = await tools.echo_text({ text: 'y'.repeat(100) })
      echoed.text.length
    `)
    expect(runValue(atCap).result).toBe(100)
    expect(events).toEqual([])
    expect(store?.saves).toEqual([])

    // A result whose RENDER exceeds the cap by one byte is the first size that
    // spills: the boundary is `>` on the model-facing text.
    const overCap = await runRepl(agent, `
      const echoed = await tools.echo_text({ text: 'y'.repeat(101) })
      echoed.text
    `)
    expect(runValue(overCap).result).toBe('y'.repeat(101))
    expect(store?.saves).toHaveLength(1)
  })
})

describe('scenario 5: a refusing spill backend', () => {
  it('keeps the tool successful with inline content, an observable warning, and no fake locator', async () => {
    const { context, store, events, agent } = await bootPrime({ backend: 'failing' })
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    const expectedRows = reportRows(300, false)

    const execution = await runRepl(agent, `
      const report = await tools.big_report({ rows: 300, marker: 'ALPHA' })
      report.rows.join('')
    `)

    // A storage failure must never turn a successful call into an error, nor hide content.
    expect(execution.isError).toBe(false)
    const value = runValue(execution)
    expect(value.result).toBe(expectedRows.join(''))
    const content = textOf(execution.content)
    expect(content).toBe(renderRepl(value))
    expect(content).toContain('row-0150')
    expect(content).not.toContain('Full formatted result stored at:')
    // The degradation is distinguishable from a successful spill.
    expect(warn).toHaveBeenCalled()
    expect(store?.saves).toEqual([])
    expect(events).toEqual([])
  })
})