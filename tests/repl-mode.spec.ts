import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

const signal = new AbortController().signal

/** The capability set the Prime policy requires before it will assemble a prompt. */
const ORCHESTRATION_TOOLS = [
  'subagent', 'list_agents', 'send_message', 'interrupt_agent',
  'job_output', 'job_list', 'job_kill',
]

function registerOrchestrationFixtures(ctx: Context): void {
  for (const name of ORCHESTRATION_TOOLS) {
    ctx.tools.register(defineTool({
      name,
      description: `${name} fixture`,
      parameters: { value: { type: 'string' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: args => Promise.resolve({ name, value: args.value ?? '' }),
    }))
  }
}

let root: string | undefined
let context: Context | undefined
let callNumber = 0

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callNumber = 0
})

async function bootPrime(config: Record<string, unknown> = {}): Promise<{ agent: Agent }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prime-repl-'))
  context = new Context()
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  await context.plugin(primeRuntime, { stateDirectory: join(root, 'state') })
  registerOrchestrationFixtures(context)
  await context.plugin(primeAgent, { stateDirectory: join(root, 'state'), ...config })
  return {
    agent: { id: 'repl-agent', session: { append: () => {}, header: { cwd: root } } } as unknown as Agent,
  }
}

describe('Prime REPL composition', () => {
  it('exposes only repl and states the control-plane policy', async () => {
    const { agent } = await bootPrime()

    const initialAssembly = await context!.systemPrompt.assemble({ agent })
    expect(initialAssembly.tools.map(tool => tool.name)).toEqual(['repl'])
    const sdk = initialAssembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toBeDefined()
    expect(sdk).toContain('refine:')
    expect(sdk).toContain('subagent:')
    expect(sdk).toContain('ToolCallError')
    expect(sdk).toContain('## Using the TypeScript REPL')
    expect(sdk).toContain('The `repl` tool executes one persistent TypeScript cell')
    expect(sdk).toContain('The final expression is the cell result; top-level `return` is invalid')
    expect(sdk).toContain('Convenience aliases:')
    expect(sdk).toContain('declare const agents')
    expect(sdk).toContain('declare const jobs')
    expect(sdk).not.toContain('the body of an async TypeScript function')
    expect(sdk).not.toContain('Emit results with `return`')
    expect(sdk).not.toContain('run_code')
    const repl = initialAssembly.tools[0]
    expect(repl?.description).toBe('Execute a TypeScript REPL cell.')
    expect(repl?.description).not.toContain('persistent')
    const codeSchema = (repl?.parameters.properties as Record<string, Record<string, unknown>> | undefined)?.code
    expect(codeSchema?.description).toBe('TypeScript source code for this cell.')

    const policy = initialAssembly.sections.find(section => section.name === 'prime-agent:rlm-policy')?.text ?? ''
    expect(policy).toContain('Orchestration guidance:')
    expect(policy).not.toContain('Each repl call executes the next cell')
    expect(policy).not.toContain('The final expression is the cell result')
    expect(policy).toContain('Parallelize independent read-only work')
    expect(policy).toContain('serialize side-effecting mutations')
    expect(policy).toContain('Do not sleep or busy-poll')
    expect(policy).toContain('Agent handles and job ids are different')
    expect(policy).toContain('The live session is not durable')
    expect(policy).toContain('keep only useful locators and summaries live')
    expect(policy).toContain('A failed call is a real outcome')
    expect(policy).toContain('After a restart notice, rebuild from files and verify external state before resuming mutations')
    // The stale run_code transport must not leak into the policy text.
    expect(policy).not.toContain('run_code')
  })

  it('fails closed on any model-direct call that is not repl', async () => {
    const { agent } = await bootPrime()

    for (const name of ['prime_refine', 'subagent', 'job_output']) {
      const denied = await context!.tools.execute({
        callId: CallId(`repl-mode-denied-${++callNumber}`),
        name,
        arguments: {},
        signal,
        agent,
      })
      expect(denied.isError).toBe(true)
      expect(denied.error.message).toBe('use the repl tool for this session')
    }

    // The one allowed direct call executes against the persistent realm.
    const allowed = await context!.tools.execute({
      callId: CallId(`repl-mode-allowed-${++callNumber}`),
      name: 'repl',
      arguments: { code: '21 * 2' },
      signal,
      agent,
    })
    expect(allowed.isError).toBe(false)
    expect((allowed.value as { result: number }).result).toBe(42)
  })

  it('uses the resolved custom refine tool name in the SDK', async () => {
    const { agent } = await bootPrime({ refineToolName: 'refine_rules' })

    const assembly = await context!.systemPrompt.assemble({ agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    const policy = assembly.sections.find(section => section.name === 'prime-agent:rlm-policy')?.text ?? ''
    expect(sdk).toContain('refine_rules:')
    expect(sdk).not.toContain('prime_refine:')
    expect(policy).toContain('The live session is not durable')
    expect(policy).toContain('keep only useful locators and summaries live')
  })
})
