import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

const signal = new AbortController().signal
let ctx: Context | undefined
let root: string | undefined

function replValue(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error(result.error.message)
  if (typeof result.value !== 'object' || result.value === null || Array.isArray(result.value)
    || !('result' in result.value)) throw new Error('invalid repl result')
  return result.value.result
}

function registerHostFixtures(context: Context, files: Map<string, string>): void {
  for (const name of ['subagent', 'list_agents', 'send_message', 'interrupt_agent', 'job_output', 'job_list', 'job_kill']) {
    context.tools.register(defineTool({
      name,
      description: `${name} fixture`,
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [] },
      execute: () => Promise.resolve({ fixture: name }),
    }))
  }
  context.tools.register(defineTool({
    name: 'read',
    description: 'memory read fixture',
    parameters: {
      file_path: { type: 'string', required: true },
      offset: { type: 'integer' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: () => [],
    },
    async execute(args) {
      const content = files.get(args.file_path)
      if (content === undefined) throw new Error(`missing fixture ${args.file_path}`)
      const allLines = content.length === 0 ? [] : content.replace(/\n$/, '').split('\n')
      const offset = args.offset ?? 1
      return {
        path: args.file_path,
        offset,
        lines: allLines.slice(offset - 1).map((text, index) => ({ number: offset + index, text })),
        totalLines: allLines.length,
      }
    },
  }))
  context.tools.register(defineTool({
    name: 'write',
    description: 'memory write fixture',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true } },
      },
      render: () => [],
    },
    async execute(args) {
      files.set(args.file_path, args.content)
      return { path: args.file_path }
    },
  }))
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('apply_patch through the Prime Realm', () => {
  it('updates through tools.apply_patch while the outer model catalog remains repl-only', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-apply-patch-'))
    const stateDirectory = join(root, 'state')
    const files = new Map([['src/a.txt', 'old\n']])
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(primeRuntime, { stateDirectory })
    registerHostFixtures(ctx, files)
    await ctx.plugin(primeAgent, { stateDirectory })

    const agent = {
      id: SessionId('prime-apply-patch'),
      session: { header: { cwd: root }, append: () => {} },
    } as unknown as Agent
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['repl'])
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('apply_patch')

    const patch = `*** Begin Patch
*** Update File: src/a.txt
@@
-old
+new
*** End Patch`
    const result = await ctx.tools.execute({
      callId: CallId('prime-apply-patch-repl'),
      name: 'repl',
      arguments: { code: `await tools.apply_patch({ patch: ${JSON.stringify(patch)} })` },
      signal,
      agent,
    })

    expect(replValue(result)).toEqual({
      applied: true,
      files: [{ path: 'src/a.txt', operation: 'update', hunks: 1 }],
    })
    expect(files.get('src/a.txt')).toBe('new\n')
  })
})
