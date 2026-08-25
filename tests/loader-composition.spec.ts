import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

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
  const stateDirectory = join(root, 'state')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: 'dsh-prime-agent/runtime'",
    '  config:',
    `    stateDirectory: ${JSON.stringify(stateDirectory)}`,
    "- name: 'dsh-prime-agent'",
    '  config:',
    `    stateDirectory: ${JSON.stringify(stateDirectory)}`,
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
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['dsh-prime-agent/runtime', primeRuntime],
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
    expect(ctx.tools.get('refine')).toBeDefined()
    // The sole model-visible transport is `repl`; the handshake bootstrap tool
    // is no longer part of the composition.
    expect(ctx.tools.get('repl')).toBeDefined()
    expect(ctx.tools.get('prime_realm_identity')).toBeUndefined()

    const agent = { id: 'loader-agent' } as Agent
    expect(ctx.commands.find(agent, 'refine')).toBeDefined()
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['repl'])
    const snapshot = renderContextSnapshot(assembly)
    expect(snapshot).toContain('local harness revision 0 (untrusted advisory records;')
    expect(snapshot).toContain('- empty')
  })
})
