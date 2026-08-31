import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
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
    callId: ToolCallId(`prime-repl-${++callNumber}`),
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
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: 'Probe completed: ' + String((value as Record<string, unknown>).value) }] },
    execute: args => Promise.resolve({ probe: 'repl-probe', value: args.value ?? '' }),
  }))
  ctx.tools.register(defineTool({
    name: 'silent_probe',
    description: 'Probe the binding fallback without model presentation.',
    parameters: {},
    output: { schema: { type: 'json' }, render: () => [] },
    execute: () => Promise.resolve({ probe: 'silent' }),
  }))
  ctx.tools.register(defineTool({
    name: 'primitive_probe',
    description: 'Probe presentation of a primitive canonical value.',
    parameters: {},
    output: { schema: { type: 'integer' }, render: () => [{ type: 'text', text: 'Primitive completed: 7' }] },
    execute: () => Promise.resolve(7),
  }))
  ctx.tools.register(defineTool({
    name: 'mixed_content_probe',
    description: 'Probe presentation of mixed text and image content.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: () => [{
        type: 'text',
        text: 'Image metadata: 1x1',
      }, {
        type: 'image',
        attachment: {
          attachmentId: 'fixture-image' as never,
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      }],
    },
    execute: () => Promise.resolve({ image: 'fixture-image' }),
  }))
  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'Probe RegExp argument projection.',
    parameters: {
      pattern: { type: 'string', required: true },
      path: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: () => [] },
    execute: args => Promise.resolve({ pattern: args.pattern }),
  }))
}

describe('Prime realm through the sole repl transport', () => {
  it('persists live values per agent while hiding the handshake and exposing one wire tool', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-repl-'))
    const stateDirectory = join(root, 'state')
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(primeRuntime, { stateDirectory })
    registerFixtures(ctx)
    await ctx.plugin(primeAgent, { stateDirectory })

    const alpha = testAgent('prime-alpha', root)
    const beta = testAgent('prime-beta', root)

    const assembly = await ctx.systemPrompt.assemble({ agent: alpha.agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['repl'])
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).not.toContain('refine:')
    const refineStatus = await runRepl(alpha.agent, 'await refine.status()')
    expect(refineStatus.result).toEqual({ pending: false, in_flight: false })
    const refineRun = await runRepl(alpha.agent, "await refine.run('validated focus')")
    expect(refineRun.result).toEqual({ pending: true, in_flight: false, scheduled: true })
    expect(alpha.events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])

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

    // Model code receives canonical JSON, while returning that exact object as
    // the completion uses the tool's compact official presentation.
    const canonical = await runRepl(alpha.agent, `
      const probe = await tools.repl_probe({ value: 'bridge-ok' });
      ({ probe: probe.probe, value: probe.value })
    `)
    expect(canonical.result).toEqual({ probe: 'repl-probe', value: 'bridge-ok' })
    const presented = await runRepl(alpha.agent, `await tools.repl_probe({ value: 'bridge-ok' })`)
    expect(presented.result).toBe('Probe completed: bridge-ok')

    // A tool with no text rendering falls back to its canonical value.
    const fallback = await runRepl(alpha.agent, `await tools.silent_probe({})`)
    expect(fallback.result).toEqual({ probe: 'silent' })

    // Primitive canonical values have no object identity to associate.
    const primitivePresentation = await runRepl(alpha.agent, `await tools.primitive_probe({})`)
    expect(primitivePresentation.result).toBe(7)

    const mixedPresentation = await runRepl(alpha.agent, `await tools.mixed_content_probe({})`)
    expect(mixedPresentation.result).toBe('Image metadata: 1x1')

    const regexpSourcePattern = await runRepl(
      alpha.agent,
      String.raw`await tools.grep({ pattern: /constructor\(/.source, path: '.' })`,
    )
    expect(regexpSourcePattern.result).toEqual({ pattern: String.raw`constructor\(` })

    await expect(runRepl(
      alpha.agent,
      `await tools.grep({ pattern: /constructor\\(/, path: '.' })`,
    )).rejects.toThrow('binding arguments must be lossless JSON')

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

    // Ordinary nested tools use official dispatch records; the private refine
    // Skill bridge above did not manufacture a tool call.
    const dispatches = alpha.events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches.length).toBeGreaterThan(0)
    expect(JSON.stringify(dispatches)).not.toContain('refine')
    expect(beta.events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })
})
