import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapRepl(result: ToolExecutionResult): { logs: string[], result?: unknown } {
  if (result.isError) throw new Error(result.error.message)
  if (!isRecord(result.value) || !Array.isArray(result.value.logs)
    || !result.value.logs.every(log => typeof log === 'string')) {
    throw new Error('invalid repl result')
  }
  return {
    logs: result.value.logs,
    ...('result' in result.value ? { result: result.value.result } : {}),
  }
}

async function runRepl(agent: Agent, code: string): Promise<{ logs: string[], result?: unknown }> {
  if (ctx === undefined) throw new Error('test context was not created')
  return unwrapRepl(await ctx.tools.execute({
    callId: CallId(`prime-repl-${++callNumber}`),
    name: 'repl',
    arguments: { code },
    signal,
    agent,
  }))
}

/** The host capabilities the Prime policy requires, registered as test fixtures. */
function registerFixtures(ctx: Context): void {
  for (const name of ['subagent', 'list_agents', 'send_message', 'interrupt_agent', 'job_output', 'job_list', 'job_kill']) {
    ctx.tools.register(defineTool({
      name,
      description: `${name} fixture`,
      parameters: { value: { type: 'string' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: args => Promise.resolve({ name, value: args.value ?? '' }),
    }))
  }
  ctx.tools.register(defineTool({
    name: 'repl_probe',
    description: 'Probe the repl bridge binding.',
    parameters: { value: { type: 'string' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: args => Promise.resolve({ probe: 'repl-probe', value: args.value ?? '' }),
  }))
}

describe('Prime realm through the sole repl transport', () => {
  it('persists live values per agent while hiding the handshake and exposing one wire tool', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-repl-'))
    const stateDirectory = join(root, 'state')
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(primeRuntime, { stateDirectory })
    registerFixtures(ctx)
    await ctx.plugin(primeAgent, { stateDirectory })

    const alpha = testAgent('prime-alpha', root)
    const beta = testAgent('prime-beta', root)

    const assembly = await ctx.systemPrompt.assemble({ agent: alpha.agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['repl'])

    const first = await runRepl(alpha.agent, `
      const lookup = new Map([['a', { id: 'a' }]])
      const read = (id: string) => lookup.get(id)
      lookup.size
    `)
    expect(first.result).toBe(1)

    const second = await runRepl(alpha.agent, 'read("a")')
    expect(second.result).toEqual({ id: 'a' })

    const isolated = await runRepl(beta.agent, '({ empty: typeof read === "undefined" })')
    expect(isolated.result).toEqual({ empty: true })

    // Nested host tools arrive through the bridge and resolve to canonical JSON.
    const nested = await runRepl(alpha.agent, `await tools.repl_probe({ value: 'bridge-ok' })`)
    expect(nested.result).toEqual({ probe: 'repl-probe', value: 'bridge-ok' })

    // No handshake bootstrap exists in the realm: the identity binding is gone,
    // `repl` itself is not re-exposed, and the bridge supplies the delegation
    // and job aliases next to the raw tool table.
    const hidden = await runRepl(alpha.agent, `
      ({
        member: 'prime_realm_identity' in tools,
        access: tools.prime_realm_identity === undefined,
        replHidden: 'repl' in tools === false,
        hasProbe: typeof tools.repl_probe === 'function',
        agentsAliases: typeof agents.spawn === 'function' && typeof agents.send === 'function',
        jobsAliases: typeof jobs.list === 'function' && typeof jobs.output === 'function',
      })
    `)
    expect(hidden.result).toEqual({
      member: false,
      access: true,
      replHidden: true,
      hasProbe: true,
      agentsAliases: true,
      jobsAliases: true,
    })

    // The bridge dispatches through the registry; no handshake or code-dispatch
    // projection ever reaches the session log.
    expect(alpha.events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
    expect(beta.events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })
})
