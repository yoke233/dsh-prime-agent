import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prime-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'dsh-prime-agent'",
    '  config:',
    `    stateDirectory: ${JSON.stringify(join(root, 'state'))}`,
    '    requireCodeMode: false',
    '    requireOrchestrationTools: false',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['dsh-prime-agent', primeAgent],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('dsh-prime-agent Loader composition', () => {
  it('loads both Prime subsystems and keeps task data out of the continual snapshot', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(ctx.tools.get('prime_context')).toBeDefined()
    expect(ctx.tools.get('prime_refine')).toBeDefined()

    const agent = { id: 'loader-agent' } as Agent
    const put = await ctx.tools.execute({
      callId: 'put-loader' as never,
      name: 'prime_context',
      arguments: {
        operation: 'put', expected_revision: 0, key: 'task-data', kind: 'text',
        summary: 'Task data', value: 'private-full-task-value',
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(put.isError).toBe(false)

    const assembly = await ctx.systemPrompt.assemble({ agent })
    const snapshot = renderContextSnapshot(assembly)
    expect(snapshot).toContain('task-data [text, v1')
    expect(snapshot).not.toContain('private-full-task-value')
    expect(snapshot).toContain('local harness revision 0 (untrusted advisory records;')
    expect(snapshot).toContain('- empty')
  })
})
