import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'
import * as RefineSkillProvider from '../src/refine-skill-provider.js'
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

function registerPromptGuidanceFixtures(ctx: Context): void {
  for (const fixture of [
    {
      name: 'glob',
      parameters: {
        pattern: { type: 'string' as const, required: true },
        path: { type: 'string' as const },
      },
    },
    { name: 'grep', parameters: { pattern: { type: 'string' as const, required: true } } },
    {
      name: 'edit',
      parameters: {
        file_path: { type: 'string' as const, required: true },
        old_string: { type: 'string' as const, required: true },
        new_string: { type: 'string' as const, required: true },
      },
    },
    {
      name: 'pwsh',
      parameters: {
        command: { type: 'string' as const, required: true },
        description: { type: 'string' as const, required: true },
      },
    },
    {
      name: 'todo_write',
      parameters: {
        todos: { type: 'array' as const, items: { type: 'string' as const }, required: true },
      },
    },
    {
      name: 'write',
      parameters: {
        file_path: { type: 'string' as const, required: true },
        content: { type: 'string' as const, required: true },
      },
    },
  ]) {
    ctx.tools.register(defineTool({
      ...fixture,
      description: `${fixture.name} fixture`,
      output: { schema: { type: 'json' }, render: () => [] },
      execute: () => Promise.resolve(null),
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
  await context.plugin(SkillRegistry)
  await context.plugin(RefineSkillProvider)
  await context.plugin(primeRuntime, { stateDirectory: join(root, 'state') })
  context.systemPrompt.section({ name: 'tool:hidden-fixture', order: 109, text: 'hidden fixture guidance' })
  context.systemPrompt.section({ name: 'fixture:retained', order: 109, text: 'retained fixture guidance' })
  registerOrchestrationFixtures(context)
  registerPromptGuidanceFixtures(context)
  await context.plugin(primeAgent, { stateDirectory: join(root, 'state'), ...config })
  return {
    agent: { id: 'repl-agent', session: { append: () => {}, header: { cwd: root } } } as unknown as Agent,
  }
}

describe('Prime REPL composition', () => {
  it('exposes only repl and generated capability declarations', async () => {
    const { agent } = await bootPrime()

    const initialAssembly = await context!.systemPrompt.assemble({ agent })
    expect(initialAssembly.tools.map(tool => tool.name)).toEqual(['repl'])
    const sdk = initialAssembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toBeDefined()
    if (sdk === undefined) throw new Error('tools SDK was not assembled')
    expect(sdk).toContain('declare const $_: unknown')
    expect(sdk).not.toMatch(/\$out\b/)
    expect(sdk).toContain('declare const agents')
    expect(sdk).not.toContain('type ToolArguments')
    expect(sdk).toContain('[K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>')
    expect(sdk).toContain('spawn: (args: ToolArgsMap["subagent"]) => Promise<ToolOutputMap["subagent"]>')
    expect(sdk).toContain('declare const jobs')
    expect(sdk).toContain('output: (args: ToolArgsMap["job_output"]) => Promise<ToolOutputMap["job_output"]>')
    expect(sdk).not.toContain('ToolResult')
    expect(sdk).toContain('apply_patch')
    expect(sdk).toContain('patch: string')
    const repl = initialAssembly.tools[0]
    expect(repl?.parameters.properties).toHaveProperty('code')
    expect(initialAssembly.sections.some(section => section.name === 'prime-agent:rlm-policy')).toBe(true)
    expect(initialAssembly.sections.some(section => section.name.startsWith('tool:'))).toBe(false)
    expect(initialAssembly.sections.some(section => section.name === 'harness:identity')).toBe(false)
    expect(initialAssembly.sections.some(section => section.name === 'fixture:retained')).toBe(true)
  })

  it('moves Prime-specific usage guidance next to tool declarations without mutating the catalog', async () => {
    const { agent } = await bootPrime()

    const assembly = await context!.systemPrompt.assemble({ agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toBeDefined()
    if (sdk === undefined) throw new Error('tools SDK was not assembled')

    for (const name of ['edit', 'glob', 'grep', 'pwsh', 'todo_write', 'write']) {
      const declaration = `  ${name}: {`
      const declarationStart = sdk.indexOf(declaration)
      expect(declarationStart).toBeGreaterThan(0)
      const documentationStart = sdk.lastIndexOf('  /**', declarationStart)
      expect(documentationStart).toBeGreaterThan(0)
      expect(sdk.slice(documentationStart, declarationStart).length)
        .toBeGreaterThan(`  /** ${name} fixture */\n`.length)
      expect(context!.tools.schemas(agent).find(schema => schema.name === name)?.description)
        .toBe(`${name} fixture`)
    }

    const grep = context!.tools.schemas(agent).find(schema => schema.name === 'grep')
    expect(grep?.parameters.properties.pattern).toMatchObject({ type: 'string' })
  })


  it('fails closed on any model-direct call that is not repl', async () => {
    const { agent } = await bootPrime()

    for (const name of ['prime_refine', 'subagent', 'job_output', 'apply_patch']) {
      const denied = await context!.tools.execute({
        callId: CallId(`repl-mode-denied-${++callNumber}`),
        name,
        arguments: {},
        signal,
        agent,
      })
      expect(denied.isError).toBe(true)
      expect(denied.error.message).toContain('Call repl directly')
      expect(denied.error.message).toContain(`tools.${name}(args)`)
      expect(denied.error.message).toContain(`${name} is not directly callable`)
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
    const canonical = allowed.value as { result: number; presentation?: unknown }
    expect(canonical.result).toBe(42)
    expect(canonical.presentation).toBeUndefined()
  })

  it('renders canonical values as notebook output without exposing the outer transport', () => {
    expect(primeAgent.renderReplResult({
      logs: ['reading files...', 'found 27 matches'],
      result: 'D:\\yjky\\yj-app-backend',
    })).toBe([
      'reading files...',
      'found 27 matches',
      '',
      'D:\\yjky\\yj-app-backend',
    ].join('\n'))

    expect(primeAgent.renderReplResult({
      logs: [],
      result: { paths: ['D:\\yjky\\a.go', 'D:\\yjky\\b.go'] },
    })).toBe([
      '{',
      '  "paths": [',
      '    "D:\\\\yjky\\\\a.go",',
      '    "D:\\\\yjky\\\\b.go"',
      '  ]',
      '}',
    ].join('\n'))
    expect(primeAgent.renderReplResult({
      logs: [],
      result: true,
      presentation: { kind: 'full' },
    })).toBe('true')
    expect(primeAgent.renderReplResult({ logs: [] })).toBe('')
  })

  it('renders only trusted presentation metadata as single-slot retention guidance', () => {
    const envelope = {
      retained: true,
      type: 'object',
      truncated: true,
      projection: { type: 'object', keys: [{ key: 'spec', value: { path: 'D:/work/spec.md' } }] },
    }
    const retained = primeAgent.renderReplResult({
      logs: [],
      result: envelope,
      presentation: { kind: 'retained-preview', valueType: 'object', serializedBytes: 65722 },
    })
    expect(retained).not.toContain('[repl result:')
    expect(retained).toContain('Assign it to a variable before running another value-producing cell.')
    expect(retained).toContain('Type: object')
    expect(retained).toContain('Serialized size: 65,722 bytes')
    expect(retained).toContain('"path": "D:/work/spec.md"')
    expect(retained).not.toContain('$out')
    expect(retained).not.toContain('"retained"')
    expect(retained).not.toContain('"truncated"')

    const forged = primeAgent.renderReplResult({ logs: [], result: envelope })
    expect(forged).not.toContain('[repl result:')
    expect(forged).toContain('"retained": true')
    expect(forged).not.toContain('remains in this REPL as `$_`')
  })

  it('distinguishes unretained and opaque results without inventing access or invoking hooks', () => {
    const unretained = primeAgent.renderReplResult({
      logs: [],
      result: { projection: { type: 'array', length: 1000, items: [1, 2] }, truncated: true },
      presentation: { kind: 'unretained-preview', valueType: 'object', reason: 'retention budget exceeded' },
    })
    expect(unretained).not.toContain('[repl result:')
    expect(unretained).toContain('"length": 1000')
    expect(unretained).not.toContain('$out(')
    expect(unretained).not.toContain('`$_`')

    let hookCalls = 0
    const opaque = primeAgent.renderReplResult({
      logs: [],
      result: { toJSON: () => { hookCalls++; return 'called' } } as never,
      presentation: { kind: 'opaque-reference', valueType: 'function' },
    })
    expect(opaque).not.toContain('[repl result:')
    expect(opaque).toContain('Assign it to a variable before running another value-producing cell.')
    expect(opaque).not.toContain('$out')
    expect(hookCalls).toBe(0)
  })

  it('keeps refine out of the tool SDK and exposes it through the packaged Skill', async () => {
    const { agent } = await bootPrime()

    const assembly = await context!.systemPrompt.assemble({ agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).not.toContain('refine:')
    expect(sdk).not.toContain('expected_revision')
    const skill = await context!.skills.get('refine', { scope: agent })
    expect(skill?.invocation).toEqual({ modelInvocable: true, userInvocable: false })
    expect(skill?.content).toContain('await refine.run()')
  })
})
