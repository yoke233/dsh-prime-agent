import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { registerApplyPatch } from '../src/apply-patch/plugin.js'

const contexts: Context[] = []
const signal = new AbortController().signal

interface Harness {
  ctx: Context
  agent: Agent
  files: Map<string, string>
  reads: ToolRunContext[]
  writes: ToolRunContext[]
  failWritePath: { value?: string }
  readPageSize: { value: number }
  readFault: { value?: 'gap' | 'empty' | 'truncated' }
  outerToken: { value?: ToolRunContext['token'] }
}

async function harness(initial: Record<string, string>): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const files = new Map(Object.entries(initial))
  const reads: ToolRunContext[] = []
  const writes: ToolRunContext[] = []
  const failWritePath: { value?: string } = {}
  const readPageSize = { value: Number.POSITIVE_INFINITY }
  const readFault: Harness['readFault'] = {}
  const outerToken: Harness['outerToken'] = {}

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'fixture read',
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
    async execute(args, exec) {
      reads.push(exec)
      const content = files.get(args.file_path)
      if (content === undefined) throw new HarnessError(`missing fixture ${args.file_path}`, 'FS_NOT_FOUND')
      const allLines = content.length === 0 ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/)
      const offset = args.offset ?? 1
      const selected = allLines.slice(offset - 1, offset - 1 + readPageSize.value)
      const page = readFault.value === 'empty' ? [] : selected
      return {
        path: args.file_path,
        offset,
        lines: page.map((text, index) => ({
          number: offset + index + (readFault.value === 'gap' ? 1 : 0),
          text: readFault.value === 'truncated' ? `${text}... (line truncated to 2000 chars)` : text,
        })),
        totalLines: allLines.length,
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'fixture write',
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
    async execute(args, exec) {
      writes.push(exec)
      if (failWritePath.value === args.file_path) throw new Error('fixture write failure')
      files.set(args.file_path, args.content)
      return { path: args.file_path }
    },
  }))
  registerApplyPatch(ctx)
  ctx.tools.guard((exec) => {
    if (exec.name === 'apply_patch' && exec.parent === undefined) outerToken.value = exec.token
    return undefined
  })
  ctx.tools.guard(exec => exec.parent === undefined && (exec.name === 'read' || exec.name === 'write')
    ? 'filesystem leaves must be nested'
    : undefined)
  const agent = { id: 'patch-agent', session: { append: () => {}, header: { cwd: 'D:/workspace' } } } as unknown as Agent
  return { ctx, agent, files, reads, writes, failWritePath, readPageSize, readFault, outerToken }
}

async function apply(h: Harness, patch: string) {
  return await h.ctx.tools.execute({
    callId: CallId('patch-root'),
    name: 'apply_patch',
    arguments: { patch },
    agent: h.agent,
    signal,
  })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => { await ctx.fiber.dispose() }))
})

describe('apply_patch registry integration', () => {
  it('registers once and re-enters the official catalog with trusted child execution identity', async () => {
    const h = await harness({ 'src/a.txt': 'old\n' })
    const schema = h.ctx.tools.schemas(h.agent).find(item => item.name === 'apply_patch')
    expect(schema).toBeDefined()
    expect(Object.keys(schema?.parameters.properties ?? {})).toEqual(['patch'])

    const result = await apply(h, `*** Begin Patch
*** Update File: src/a.txt
@@
-old
+new
*** End Patch`)

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      applied: true,
      files: [{ path: 'src/a.txt', operation: 'update', hunks: 1 }],
    })
    expect(h.files.get('src/a.txt')).toBe('new\n')
    expect(h.reads).toHaveLength(1)
    expect(h.writes).toHaveLength(1)
    for (const child of [...h.reads, ...h.writes]) {
      expect(child.agent).toBe(h.agent)
      expect(child.signal).toBe(signal)
      expect(String(child.rootCallId)).toBe('patch-root')
      expect(child.parent).toBe(h.outerToken.value)
      expect(String(child.callId)).toMatch(/^patch-root:apply_patch:\d+$/)
    }
    expect(String(h.reads[0]!.callId)).not.toBe(String(h.writes[0]!.callId))
  })

  it('preflights a missing Add target before creating it through write', async () => {
    const h = await harness({})
    const result = await apply(h, `*** Begin Patch
*** Add File: src/new.txt
+hello
*** End Patch`)

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      applied: true,
      files: [{ path: 'src/new.txt', operation: 'add', hunks: 1 }],
    })
    expect(h.reads).toHaveLength(1)
    expect(h.writes).toHaveLength(1)
    expect(h.files.get('src/new.txt')).toBe('hello\n')
  })

  it('reads every contiguous page and normalizes the line DTO boundary to LF text', async () => {
    const h = await harness({ 'src/a.txt': 'one\r\ntwo\r\nthree\r\n' })
    h.readPageSize.value = 1
    const result = await apply(h, `*** Begin Patch
*** Update File: src/a.txt
@@
-two
+TWO
*** End Patch`)

    expect(result.isError).toBe(false)
    expect(h.reads).toHaveLength(3)
    expect(h.reads.map(read => String(read.callId))).toEqual([
      'patch-root:apply_patch:1',
      'patch-root:apply_patch:2',
      'patch-root:apply_patch:3',
    ])
    expect(h.files.get('src/a.txt')).toBe('one\nTWO\nthree\n')
  })

  it('fails closed on missing, non-contiguous, or truncated read pages', async () => {
    for (const fault of ['empty', 'gap', 'truncated'] as const) {
      const h = await harness({ 'src/a.txt': 'old\n' })
      h.readFault.value = fault
      const result = await apply(h, `*** Begin Patch
*** Update File: src/a.txt
@@
-old
+new
*** End Patch`)
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error(`malformed ${fault} snapshot unexpectedly succeeded`)
      expect(result.error.info?.code).toBe('SNAPSHOT_READ_FAILED')
      expect(h.writes).toHaveLength(0)
      expect(h.files.get('src/a.txt')).toBe('old\n')
    }
  })

  it('performs no write when parsing or complete planning fails', async () => {
    const invalid = await harness({ 'src/a.txt': 'old\n' })
    const parseFailure = await apply(invalid, 'not a patch')
    expect(parseFailure.isError).toBe(true)
    if (!parseFailure.isError) throw new Error('invalid patch unexpectedly succeeded')
    expect(parseFailure.error.info?.code).toBe('INVALID_PATCH')
    expect(invalid.reads).toHaveLength(0)
    expect(invalid.writes).toHaveLength(0)

    const mismatch = await harness({ 'src/a.txt': 'old\n' })
    const planFailure = await apply(mismatch, `*** Begin Patch
*** Update File: src/a.txt
@@
-missing
+new
*** End Patch`)
    expect(planFailure.isError).toBe(true)
    if (!planFailure.isError) throw new Error('mismatched patch unexpectedly succeeded')
    expect(planFailure.error.info?.code).toBe('CONTEXT_NOT_FOUND')
    expect(mismatch.reads).toHaveLength(1)
    expect(mismatch.writes).toHaveLength(0)
    expect(mismatch.files.get('src/a.txt')).toBe('old\n')
  })

  it('reports ordered partial application without claiming rollback or atomicity', async () => {
    const h = await harness({ 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' })
    h.failWritePath.value = 'src/b.txt'
    const result = await apply(h, `*** Begin Patch
*** Update File: src/a.txt
@@
-a
+A
*** Update File: src/b.txt
@@
-b
+B
*** End Patch`)

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('partial patch unexpectedly succeeded')
    expect(result.error.message).toContain('patch partially applied; wrote src/a.txt before src/b.txt failed')
    expect(result.error.info?.code).toBe('PARTIAL_APPLY')
    expect(h.files.get('src/a.txt')).toBe('A\n')
    expect(h.files.get('src/b.txt')).toBe('b\n')
    expect(h.writes).toHaveLength(2)
  })
})
