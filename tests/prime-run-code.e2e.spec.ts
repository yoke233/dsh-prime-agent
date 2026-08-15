import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { registerRealmIdentity } from '../src/realm/identity-tool.js'
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

function testAgent(id: string, cwd: string): Agent {
  const events: unknown[] = []
  return {
    id: SessionId(id),
    session: {
      header: { cwd },
      append: (event: unknown) => { events.push(event) },
    },
  } as unknown as Agent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapRunCode(result: ToolExecutionResult): { logs: string[], result?: unknown } {
  if (result.isError) throw new Error(result.error.message)
  if (!isRecord(result.value) || !Array.isArray(result.value.logs)
    || !result.value.logs.every(log => typeof log === 'string')) {
    throw new Error('invalid run_code result')
  }
  return {
    logs: result.value.logs,
    ...('result' in result.value ? { result: result.value.result } : {}),
  }
}

async function runCode(agent: Agent, code: string): Promise<{ logs: string[], result?: unknown }> {
  if (ctx === undefined) throw new Error('test context was not created')
  const execution = await ctx.tools.execute({
    callId: CallId(`prime-run-code-${++callNumber}`),
    name: RUN_CODE_NAME,
    arguments: { code, description: 'Execute the Prime E2E program' },
    signal,
    agent,
  })
  return unwrapRunCode(execution)
}

describe('Prime realm through the real run_code transport', () => {
  it('persists live values per agent while hiding the handshake and exposing one wire tool', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-run-code-'))
    const stateDirectory = join(root, 'state')
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'code' })
    await ctx.plugin(primeRuntime, { stateDirectory })
    registerRealmIdentity(ctx, { stateDirectory })

    const alpha = testAgent('prime-alpha', root)
    const beta = testAgent('prime-beta', root)

    const assembly = await ctx.systemPrompt.assemble({ agent: alpha })
    expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])

    const first = await runCode(alpha, `
      const lookup = new Map([['a', { id: 'a' }]])
      const read = (id: string) => lookup.get(id)
      lookup.size
    `)
    expect(first.result).toBe(1)

    const second = await runCode(alpha, 'read("a")')
    expect(second.result).toEqual({ id: 'a' })

    const isolated = await runCode(beta, '({ empty: typeof read === "undefined" })')
    expect(isolated.result).toEqual({ empty: true })

    const hidden = await runCode(alpha, `
      ({
        member: 'prime_realm_identity' in tools,
        keys: Object.keys(tools),
        access: tools.prime_realm_identity === undefined,
      })
    `)
    expect(hidden.result).toEqual({ member: false, keys: [], access: true })
  })
})
