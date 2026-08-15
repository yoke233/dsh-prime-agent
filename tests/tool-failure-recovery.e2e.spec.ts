/**
 * Failure recovery acceptance through the real `run_code` transport
 * over the real ToolRuntime, the real Prime runtime, and the real realm identity
 * tool. Every assertion here is about what a FAILURE leaves behind — which
 * independent results survive, whether the realm generation is still trustworthy,
 * whether a completed side effect is still true, and whether a broken identity
 * link runs the program at all.
 *
 * `ToolCallError` is a binding exception the worker mints inside the realm; the
 * host has no runtime export of it. Programs therefore decide `instanceof` in the
 * realm and return the verdict as data, which is what these tests inspect.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult, ToolFailure } from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'
import { registerRealmIdentity } from '../src/realm/identity-tool.js'
import * as primeRuntime from '../src/runtime.js'

const LOST = '[prime-realm] live namespace restarted; previous bindings were lost'
const MISSING_PATH = 'missing.txt'
const READABLE_PATH = 'alpha.txt'

const signal = new AbortController().signal

let ctx: Context | undefined
let root: string | undefined
let callNumber = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callNumber = 0
})

interface TestAgent {
  agent: Agent
  events: { type: string, data: unknown }[]
}

function testAgent(id: string, cwd: string): TestAgent {
  const events: { type: string, data: unknown }[] = []
  const agent = {
    id: SessionId(id),
    session: {
      header: { cwd },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  return { agent, events }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function makeRoot(prefix: string): Promise<string> {
  root = await mkdtemp(join(tmpdir(), prefix))
  return root
}

function stateDirectory(): string {
  if (root === undefined) throw new Error('test root was not created')
  return join(root, 'state')
}

interface HostOptions {
  /** Extra config for the Prime host runtime row (budgets, pool ceilings). */
  runtime?: Record<string, unknown>
  /** Mount the whole `dsh-prime-agent` row instead of registering identity directly. */
  workspace?: boolean
  /**
   * Register the realm identity tool over a DIFFERENT state directory than the
   * runtime verifies against — the deployment miswiring scenario 6 exercises.
   * Ignored when `workspace` mounts the plugin's own identity registration.
   */
  identityDirectory?: string
  /** Deployment tools the program under test is allowed to call. */
  tools?: ToolDefinition[]
}

/** Boot the real Code Mode stack with the Prime runtime in the official row's place. */
async function startHost(options: HostOptions = {}): Promise<Context> {
  const context = new Context()
  ctx = context
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime, { mode: 'code' })
  await context.plugin(primeRuntime, { stateDirectory: stateDirectory(), ...options.runtime })
  if (options.workspace === true) {
    // The plugin registers the identity tool itself, over the same directory.
    await context.plugin(primeAgent, {
      stateDirectory: stateDirectory(),
      requireCodeMode: false,
      requireOrchestrationTools: false,
    })
  } else {
    registerRealmIdentity(context, { stateDirectory: options.identityDirectory ?? stateDirectory() })
  }
  for (const tool of options.tools ?? []) context.tools.register(tool)
  return context
}

async function call(agent: Agent, code: string): Promise<ToolExecutionResult> {
  if (ctx === undefined) throw new Error('test context was not created')
  return await ctx.tools.execute({
    callId: CallId(`prime-failure-${++callNumber}`),
    name: RUN_CODE_NAME,
    arguments: { code, description: 'Exercise Prime failure recovery' },
    signal,
    agent,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The successful `run_code` completion, or a test failure naming the error. */
async function completes(agent: Agent, code: string): Promise<{ logs: string[], result?: unknown }> {
  const execution = await call(agent, code)
  if (execution.isError) throw new Error(`run_code failed unexpectedly: ${execution.error.message}`)
  if (!isRecord(execution.value) || !Array.isArray(execution.value.logs)
    || !execution.value.logs.every(log => typeof log === 'string')) {
    throw new Error('invalid run_code result')
  }
  return {
    logs: execution.value.logs as string[],
    ...('result' in execution.value ? { result: execution.value.result } : {}),
  }
}

/** The structured outer failure of a `run_code` execution. */
async function fails(agent: Agent, code: string): Promise<ToolFailure> {
  const execution = await call(agent, code)
  if (!execution.isError) throw new Error(`run_code unexpectedly succeeded: ${JSON.stringify(execution.value)}`)
  return execution.error
}

function dispatches(agent: TestAgent, name: string): { isError: boolean }[] {
  return agent.events
    .filter(event => event.type === 'tool/code-dispatch' && isRecord(event.data) && event.data.name === name)
    .map(event => ({ isError: (event.data as { isError: boolean }).isError }))
}

/** Read probe whose failure is an ordinary Tool execution failure, not misuse. */
function readTool(observed: { inFlight: number, maxInFlight: number, reads: string[] }): ToolDefinition {
  return defineTool({
    name: 'probe_read',
    description: 'Read one probe path. A missing path fails the call the way an ordinary Tool failure does.',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // Declared parallel-safe so a program's `Promise.all` really does overlap the
    // two dispatches instead of being serialized by the fail-closed default.
    isConcurrencySafe: () => true,
    async execute(args) {
      observed.inFlight += 1
      observed.maxInFlight = Math.max(observed.maxInFlight, observed.inFlight)
      observed.reads.push(args.path)
      try {
        // Long enough that two genuinely parallel dispatches overlap, short
        // enough that a serialized pair still finishes the test.
        await sleep(80)
        if (args.path === MISSING_PATH) {
          throw new Error(`ENOENT: no such file or directory, open '${MISSING_PATH}'`)
        }
        return { path: args.path, text: 'alpha contents' }
      } finally {
        observed.inFlight -= 1
      }
    },
  })
}

/** Durable, non-transactional mutation: once it returns, the file is on disk. */
function appendNoteTool(directory: string, calls: string[]): ToolDefinition {
  return defineTool({
    name: 'append_note',
    description: 'Write one durable note file. The write is not transactional and is never rolled back.',
    parameters: {
      name: { type: 'string', required: true },
      text: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true }, bytes: { type: 'integer', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `wrote ${value.path}` }],
    },
    async execute(args) {
      calls.push(args.name)
      const path = join(directory, args.name)
      await writeFile(path, args.text, 'utf8')
      return { path, bytes: Buffer.byteLength(args.text, 'utf8') }
    },
  })
}

/** Read one durable note file back; the durable store outlives realm generations. */
function readNoteTool(directory: string): ToolDefinition {
  return defineTool({
    name: 'read_note',
    description: 'Read one durable note file written by append_note.',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      return { text: await readFile(join(directory, args.name), 'utf8') }
    },
  })
}

/** Records that the program body reached a Tool at all. */
function markerTool(marks: string[]): ToolDefinition {
  return defineTool({
    name: 'mark_reached',
    description: 'Record that the program body executed.',
    parameters: { label: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { marked: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'marked' }],
    },
    execute(args) {
      marks.push(args.label)
      return Promise.resolve({ marked: true })
    },
  })
}

describe('ordinary tool failure inside a Prime program', () => {
  it('keeps the parallel sibling result when each call is captured individually', async () => {
    await makeRoot('dsh-prime-fail-percall-')
    const observed = { inFlight: 0, maxInFlight: 0, reads: [] as string[] }
    await startHost({ tools: [readTool(observed)] })
    const alpha = testAgent('failure-percall', root as string)

    // A captured tool failure is the program's business, not the realm's.
    const run = await completes(alpha.agent, `
      const attempt = async (path: string) => {
        try {
          return { ok: true, path, value: await tools.probe_read({ path }) }
        } catch (error) {
          // The ONLY place this judgement can be made: the class is injected
          // into the realm, so the host never sees the instance.
          if (error instanceof ToolCallError) {
            return { ok: false, path, isToolCallError: true, toolName: error.toolName, message: String(error.message) }
          }
          throw error
        }
      }
      await Promise.all([attempt(${JSON.stringify(READABLE_PATH)}), attempt(${JSON.stringify(MISSING_PATH)})])
    `)

    expect(Array.isArray(run.result)).toBe(true)
    const [readable, missing] = run.result as [Record<string, unknown>, Record<string, unknown>]

    // The independent success is NOT lost to its sibling's failure.
    expect(readable).toEqual({
      ok: true,
      path: READABLE_PATH,
      value: { path: READABLE_PATH, text: 'alpha contents' },
    })
    // And the failure arrived as the documented binding exception, carrying the
    // failing tool's name rather than a string the program had to parse.
    expect(missing).toMatchObject({ ok: false, path: MISSING_PATH, isToolCallError: true, toolName: 'probe_read' })
    expect(String(missing.message)).toContain('ENOENT')

    expect(observed.maxInFlight).toBe(2)
    expect(observed.reads.sort()).toEqual([READABLE_PATH, MISSING_PATH].sort())
    expect(dispatches(alpha, 'probe_read').map(entry => entry.isError).sort()).toEqual([false, true])
  }, 30_000)

  it('fails the run on a bare Promise.all rejection while the realm generation survives', async () => {
    await makeRoot('dsh-prime-fail-allof-')
    const observed = { inFlight: 0, maxInFlight: 0, reads: [] as string[] }
    await startHost({ tools: [readTool(observed)] })
    const alpha = testAgent('failure-promise-all', root as string)

    const seeded = await completes(alpha.agent, 'let progress = "seeded"; progress')
    expect(seeded.result).toBe('seeded')

    const failure = await fails(alpha.agent, `
      const both = await Promise.all([
        tools.probe_read({ path: ${JSON.stringify(READABLE_PATH)} }),
        tools.probe_read({ path: ${JSON.stringify(MISSING_PATH)} }),
      ])
      progress = "never reached"
      both
    `)
    expect(failure.message).toContain('code run failed (exception)')
    expect(failure.message).toContain('ENOENT')
    expect(failure.info).toEqual({ name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' })

    // Fail-fast does not unwind the sibling that had already been dispatched.
    expect(observed.reads).toContain(READABLE_PATH)

    // An ordinary program failure ends the run, not the realm: the live binding
    // created by the first cell remains available.
    const after = await completes(alpha.agent, 'progress')
    expect(after.result).toBe('seeded')
  }, 30_000)
})

describe('program failure inside a Prime program', () => {
  it('reports an uncaught exception as a structured isError carrying bounded captured logs', async () => {
    await makeRoot('dsh-prime-fail-program-')
    const maxOutputBytes = 8_192
    await startHost({ runtime: { maxOutputBytes } })
    const alpha = testAgent('failure-program', root as string)

    const failure = await fails(alpha.agent, `
      for (let index = 0; index < 5; index++) console.log("checkpoint " + index)
      throw new Error("program invariant broken")
    `)

    // The runtime renders the thrown value with its `Error: ` envelope and its
    // stack, so the assertion pins the prefix rather than a bare message.
    expect(failure.message).toContain('code run failed (exception): Error: program invariant broken')
    expect(failure.info).toEqual({ name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' })
    // The logs the program produced before dying are visible to the model, which
    // is what lets it write a smaller repair program instead of replaying.
    expect(failure.message).toContain('Captured output:')
    for (let index = 0; index < 5; index++) expect(failure.message).toContain(`checkpoint ${index}`)
    // Bounded: the whole failure text stays inside the deployment's output cap.
    expect(Buffer.byteLength(failure.message, 'utf8')).toBeLessThanOrEqual(maxOutputBytes)

    await completes(alpha.agent, '1')
  }, 30_000)

  it('leaves a completed mutation in place and never claims it was rolled back', async () => {
    await makeRoot('dsh-prime-fail-mutation-')
    const notes = join(root as string, 'notes')
    await mkdir(notes, { recursive: true })
    const calls: string[] = []
    await startHost({ tools: [appendNoteTool(notes, calls)] })
    const alpha = testAgent('failure-mutation', root as string)

    const failure = await fails(alpha.agent, `
      const written = await tools.append_note({ name: "ledger.txt", text: "committed entry" })
      console.log("mutation committed at " + written.path)
      throw new Error("follow-up step failed after the mutation")
    `)

    expect(failure.message).toContain('code run failed (exception): Error: follow-up step failed after the mutation')
    expect(failure.message).toContain('mutation committed at')

    // The external fact, read outside the realm: the side effect happened and
    // survived the program's death.
    expect(await readFile(join(notes, 'ledger.txt'), 'utf8')).toBe('committed entry')
    expect(calls).toEqual(['ledger.txt'])

    // Nothing in the failure text may suggest the harness undid the write.
    expect(failure.message).not.toMatch(/roll(ed|ing)? ?back|rollback|reverted|undone|restored/i)

    // And no automatic replay happens on the next run either: the mutation was
    // performed exactly once.
    await completes(alpha.agent, '1')
    expect(calls).toEqual(['ledger.txt'])
  }, 30_000)
})

describe('generation loss recovery through durable checkpoints', () => {
  it('reports the lost generation and rebuilds live bindings from the durable checkpoint', async () => {
    await makeRoot('dsh-prime-fail-generation-')
    const notes: string[] = []
    await startHost({
      workspace: true,
      runtime: { maxWallMs: 2_000 },
      tools: [appendNoteTool(root as string, notes), readNoteTool(root as string)],
    })
    const alpha = testAgent('failure-generation', root as string)

    // The checkpoint is an EXPLICIT program decision: reduce the live data and
    // write it to a durable task file before the risky stretch.
    const seeded = await completes(alpha.agent, `
      const processed = ["a", "b"]
      const note = await tools.append_note({
        name: "recovery_checkpoint.json",
        text: JSON.stringify({ processed, nextIndex: 2 }),
      })
      ;({ bytes: note.bytes, live: processed.length })
    `)
    expect(seeded.result).toMatchObject({ live: 2 })

    // Wall-clock hard kill: the worker dies with the live-only heap.
    const killed = await fails(alpha.agent, 'for (;;) {}')
    expect(killed.message).toContain('code run failed (timeout)')

    const recovered = await completes(alpha.agent, `
      const lost = typeof processed === "undefined"
      const read = await tools.read_note({ name: "recovery_checkpoint.json" })
      const checkpoint = JSON.parse(read.text)
      const rebuilt = checkpoint.processed
      ;({ lost, nextIndex: checkpoint.nextIndex, rebuilt })
    `)
    expect(recovered.result).toEqual({ lost: true, nextIndex: 2, rebuilt: ['a', 'b'] })
    // The run that actually inherits the new heap is the one that is told.
    expect(recovered.logs.at(-1)).toBe(LOST)

    // The rebuilt binding is available to later cells in the new generation.
    const settled = await completes(alpha.agent, 'rebuilt')
    expect(settled.result).toEqual(['a', 'b'])
  }, 60_000)
})

describe('identity failure on the automatic binding path', () => {
  it('fails closed without running the program when the identity wiring diverges', async () => {
    await makeRoot('dsh-prime-fail-identity-')
    const marks: string[] = []
    // One broken link in an otherwise real assembly: the agent-scoped identity
    // tool reads a DIFFERENT key than the runtime verifies against, which is the
    // documented consequence of a misconfigured deployment.
    await startHost({
      identityDirectory: join(root as string, 'divergent-state'),
      tools: [markerTool(marks)],
    })
    const alpha = testAgent('failure-identity', root as string)

    const failure = await fails(alpha.agent, `
      await tools.mark_reached({ label: "program body" })
      const ran = true
      "ran"
    `)

    expect(failure.message).toContain('realm handshake rejected')
    expect(failure.message).toContain('token authentication failed')
    expect(failure.info).toEqual({ name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' })

    // Fail-closed means the program never executed: no tool was reached, and no
    // realm notice was produced because no realm was ever entered.
    expect(marks).toEqual([])
    expect(dispatches(alpha, 'mark_reached')).toEqual([])
    expect(failure.message).not.toContain('[prime-realm]')
    expect(failure.message).not.toContain('Captured output:')

    // It also did not silently degrade to the official one-shot runtime, which
    // would have run this program and returned "ran".
    const repeated = await fails(alpha.agent, '"ran"')
    expect(repeated.message).toContain('realm handshake rejected')
    expect(marks).toEqual([])
  }, 30_000)
})
