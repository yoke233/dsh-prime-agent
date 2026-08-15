import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'

class BindingRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.behavior(request)
  }
}

function registerOrchestrationFixtures(ctx: Context): void {
  for (const name of ['subagent', 'job_output']) {
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

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Prime Code Mode composition', () => {
  it('exposes only run_code and states the control-plane policy', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-code-'))
    context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime, { mode: 'code' })
    await context.plugin(BindingRuntime)
    registerOrchestrationFixtures(context)
    await context.plugin(primeAgent, { stateDirectory: join(root, 'state') })
    const agent = {
      id: 'code-agent',
      session: { append: () => {}, header: { cwd: root } },
    } as unknown as Agent

    const initialAssembly = await context.systemPrompt.assemble({ agent })
    expect(initialAssembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    const sdk = initialAssembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toContain('prime_refine:')
    expect(sdk).toContain('subagent:')
    expect(sdk).toContain('ToolCallError')
    expect(sdk).toContain('a persistent TypeScript REPL cell')
    expect(sdk).toContain('The final expression is the result; top-level `return` is invalid')
    expect(sdk).not.toContain('the body of an async TypeScript function')
    expect(sdk).not.toContain('Emit results with `return`')
    const runCode = initialAssembly.tools[0]
    expect(runCode?.description).toContain('persistent TypeScript REPL cell')
    expect(runCode?.description).toContain('top-level `return` is invalid')
    const codeSchema = (runCode?.parameters.properties as Record<string, Record<string, unknown>> | undefined)?.code
    expect(codeSchema?.description).toContain('final expression as the result')
    const policy = initialAssembly.sections.find(section => section.name === 'prime-agent:rlm-policy')?.text ?? ''
    expect(policy).toContain('Promise.all')
    expect(policy).toContain('Promise.allSettled')
    expect(policy).toMatch(/bare Promise\.all only for an atomic group/)
    expect(policy).toMatch(/best-effort probes with a per-call catch or Promise\.allSettled/)
    expect(policy).toMatch(/side-effecting mutations sequentially/)
    expect(policy).toContain('Each run_code call is the next cell in the same live session')
    expect(policy).toContain("A cell's result is its final expression; do not use a top-level return")
    expect(policy).toContain('Reduce first, finish with the summary')
    expect(policy).toContain('keep reusable intermediates in ordinary top-level bindings')
    expect(policy).toContain('spill locator')
    expect(policy).toContain('do not blindly repeat it')
    expect(policy).toMatch(/sandbox denial, ask once for the minimum permission/)
    expect(policy).toContain('rebuild from durable checkpoints')
    expect(policy).not.toMatch(/rollback|roll back|rolled back/i)
    expect(policy).not.toMatch(/automatic/i)

    // The handoff recipe: material by file, instructions by prompt, snapshot
    // semantics, and a report that only carries conclusions and paths.
    expect(policy).toMatch(/Material travels by file, instructions travel in the prompt/)
    expect(policy).toContain('A handoff file is not edited after it is written')
    expect(policy).toContain('never bury task instructions in a data file')
    expect(policy).toContain('snapshot of the moment it was written')
    expect(policy).toContain('the same reduce-first rule, one level down')
    expect(policy).toContain('truncated past 8192 characters')
  })

  it('fails prompt assembly when the deployment does not select Code Mode', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-native-'))
    context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime, { mode: 'native' })
    registerOrchestrationFixtures(context)
    await context.plugin(primeAgent, { stateDirectory: join(root, 'state') })

    await expect(context.systemPrompt.assemble({ agent: { id: 'native-agent' } as Agent }))
      .rejects.toThrow('must use Code Mode')
  })

  it('uses the resolved custom refine tool name in the SDK', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-custom-names-'))
    context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime, { mode: 'code' })
    await context.plugin(BindingRuntime)
    registerOrchestrationFixtures(context)
    await context.plugin(primeAgent, {
      stateDirectory: join(root, 'state'),
      refineToolName: 'refine_rules',
    })

    const assembly = await context.systemPrompt.assemble({ agent: { id: 'custom-name-agent' } as Agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    const policy = assembly.sections.find(section => section.name === 'prime-agent:policy')?.text
    expect(sdk).toContain('refine_rules:')
    expect(sdk).not.toContain('prime_refine:')
    expect(policy).toContain('live namespace and durable task files')

    const rlmPolicy = assembly.sections.find(section => section.name === 'prime-agent:rlm-policy')?.text ?? ''
    expect(rlmPolicy).toContain('Reduce first, finish with the summary')
  })
})
