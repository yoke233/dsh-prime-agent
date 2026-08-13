import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
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

describe('Prime RLM Code Mode composition', () => {
  it('uses prime_context as a persistent SDK namespace while prompt context stays metadata-only', async () => {
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
    expect(sdk).toContain('prime_context:')
    expect(sdk).toContain('prime_refine:')
    expect(sdk).toContain('subagent:')
    expect(initialAssembly.sections.find(section => section.name === 'prime-agent:rlm-policy')?.text)
      .toContain('Promise.all')

    const secret = 'full-context-value-that-must-not-enter-the-catalog'
    const runtime = context.codeRuntime as BindingRuntime
    runtime.behavior = async (request) => {
      const primeContext = request.bindings[0]?.functions.prime_context
      if (primeContext === undefined) throw new Error('prime_context binding missing')
      const catalog = await primeContext({ operation: 'catalog' }) as { revision: number }
      const put = await primeContext({
        operation: 'put', expected_revision: catalog.revision, key: 'repo-map', kind: 'text',
        summary: 'Repository map', value: secret,
      })
      return { logs: [], value: put }
    }
    const putResult = await context.tools.execute({
      callId: 'run-code-put' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'return await tools.prime_context({ operation: "put", ... })', description: 'Store context' },
      signal: new AbortController().signal,
      agent,
    })
    expect(putResult.isError).toBe(false)
    if (putResult.isError) throw new Error(putResult.error.message)
    expect(putResult.value).toMatchObject({ result: { revision: 1 } })

    const assembly = await context.systemPrompt.assemble({ agent })
    const snapshot = renderContextSnapshot(assembly)
    expect(snapshot).toContain('repo-map [text, v1')
    expect(snapshot).not.toContain(secret)

    runtime.behavior = async (request) => {
      const primeContext = request.bindings[0]?.functions.prime_context
      if (primeContext === undefined) throw new Error('prime_context binding missing')
      return { logs: [], value: await primeContext({ operation: 'get', key: 'repo-map', offset: 5, limit: 12 }) }
    }
    const getResult = await context.tools.execute({
      callId: 'run-code-get' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'return await tools.prime_context({ operation: "get", ... })', description: 'Read context' },
      signal: new AbortController().signal,
      agent,
    })
    expect(getResult.isError).toBe(false)
    if (getResult.isError) throw new Error(getResult.error.message)
    expect(getResult.value).toMatchObject({ result: { result: { content: secret.slice(5, 17), truncated: true } } })
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

  it('uses resolved custom tool names in both the SDK and continual guidance', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-custom-names-'))
    context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime, { mode: 'code' })
    await context.plugin(BindingRuntime)
    registerOrchestrationFixtures(context)
    await context.plugin(primeAgent, {
      stateDirectory: join(root, 'state'),
      contextToolName: 'workspace_context',
      refineToolName: 'refine_rules',
    })

    const assembly = await context.systemPrompt.assemble({ agent: { id: 'custom-name-agent' } as Agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    const policy = assembly.sections.find(section => section.name === 'prime-agent:policy')?.text
    expect(sdk).toContain('workspace_context:')
    expect(sdk).toContain('refine_rules:')
    expect(policy).toContain('those belong in workspace_context')
    expect(policy).not.toContain('those belong in prime_context')
  })
})
