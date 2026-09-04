import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'

interface Row { id?: string; name?: string; disabled?: unknown; isolate?: Record<string, unknown>; config?: Record<string, unknown>; insert?: Row[] }

async function loadDialect(path: string): Promise<Row[]> {
  return load(await readFile(resolve(import.meta.dirname, path), 'utf8'), { schema: entryListSchema }) as Row[]
}

/** The `!!js` source of one row's `stateDirectory`, or undefined. */
function stateDirectoryExpr(row: Row | undefined): string | undefined {
  const value = row?.config?.stateDirectory
  return isJsExpr(value) ? (value as { __jsExpr: string }).__jsExpr : undefined
}

describe('Prime packaging boundary', () => {
  const BASE_PATCH = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-base/cordis.patch.yml')
  const MONITOR_PATCH = resolve(
    dirname(createRequire(import.meta.url).resolve('dsh-tool-monitor/package.json')),
    'cordis.patch.yml',
  )

  it('ships the official runtime modules used by the preset as production dependencies', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, unknown>
    }
    const runtimePackages = [
      '@deepseek-ai/dsh-code-runtime',
      '@deepseek-ai/dsh-terminal',
      '@deepseek-ai/dsh-terminal-bash',
      '@deepseek-ai/dsh-tool-terminal',
    ]

    for (const name of runtimePackages) {
      expect(manifest.dependencies?.[name]).toBeTypeOf('string')
      expect(manifest.peerDependencies).not.toHaveProperty(name)
      expect(manifest.peerDependenciesMeta).not.toHaveProperty(name)
    }
  })

  it('ships the software-engineer identity in the system preset', async () => {
    const persona = (await loadDialect('../agent-presets/prime/agent.cordis.yml'))
      .find(row => row.id === 'persona')

    expect(persona?.name).toBe('@deepseek-ai/dsh-persona')
    expect(persona?.config?.text).toMatch(/^You are a helpful software engineer assistant\./)
  })

  it('mounts one owner-isolated cross-platform persistent terminal stack', async () => {
    const preset = await loadDialect('../agent-presets/prime/agent.cordis.yml')
    const terminal = preset.find(row => row.id === 'persistent-terminal')
    const children = terminal?.config as unknown as Row[]

    expect(terminal).toMatchObject({
      name: 'cordis:group',
      isolate: { terminals: true },
    })
    expect(children.map(row => [row.id, row.name])).toEqual([
      ['terminal-registry', '@deepseek-ai/dsh-terminal'],
      ['terminal-bash', '@deepseek-ai/dsh-terminal-bash'],
      ['terminal-pwsh', '@deepseek-ai/dsh-terminal-bash'],
      ['tool-terminal', '@deepseek-ai/dsh-tool-terminal'],
    ])
    expect(children.find(row => row.id === 'terminal-bash')?.config).toEqual({ shellDialect: 'bash' })
    expect(children.find(row => row.id === 'terminal-pwsh')?.config).toEqual({ shellDialect: 'pwsh' })
    expect(isJsExpr(children.find(row => row.id === 'terminal-bash')?.disabled)).toBe(true)
    expect(isJsExpr(children.find(row => row.id === 'terminal-pwsh')?.disabled)).toBe(true)
  })

  it('configures a 12KB Prime spill policy', async () => {
    const preset = await loadDialect('../agent-presets/prime/agent.cordis.yml')
    const spill = preset.find(row => row.id === 'prime-spill-policy')
    expect(spill).toEqual({
      id: 'prime-spill-policy',
      name: '@deepseek-ai/dsh-spill-policy',
      config: { maxInlineBytes: 12000 },
    })
  })

  it('adds its host service without replacing the official code runtime', async () => {
    const patches = await loadDialect('../cordis.patch.yml')
    expect(patches).toHaveLength(1)

    const [insertRuntime] = patches
    expect(insertRuntime?.insert).toHaveLength(1)
    const runtime = insertRuntime?.insert?.[0]
    expect(runtime?.id).toBe('prime-code-runtime')
    expect(runtime?.name).toBe('dsh-prime-agent/runtime')
    expect(Object.keys(runtime?.config ?? {})).toEqual(['stateDirectory'])
  })

  it('composes when the host has no public code runtime row', async () => {
    const patches = await loadDialect('../cordis.patch.yml')
    const composed = applyEntryPatches([], patches, () => undefined) as Row[]

    expect(composed.find(row => row.id === 'code-runtime')).toBeUndefined()
    expect(composed.find(row => row.id === 'prime-code-runtime')).toEqual({
      id: 'prime-code-runtime',
      name: 'dsh-prime-agent/runtime',
      config: { stateDirectory: expect.anything() },
    })
  })

  it('pins the companion monitor bundle and composes its host registry before Prime', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    expect(manifest.devDependencies?.['dsh-tool-monitor']).toBe(
      'https://github.com/yoke233/dsh-tool-monitor/archive/1e0f2cc14b4ddbc49c2e3cb2c2a7913c80b3083f.tar.gz',
    )

    const base = load(await readFile(BASE_PATCH, 'utf8'), { schema: entryListSchema }) as Row[]
    const monitor = load(await readFile(MONITOR_PATCH, 'utf8'), { schema: entryListSchema }) as Row[]
    const prime = await loadDialect('../cordis.patch.yml')
    let composed = applyEntryPatches([], base, () => undefined) as Row[]
    composed = applyEntryPatches(composed, monitor, () => undefined) as Row[]
    composed = applyEntryPatches(composed, prime, () => undefined) as Row[]

    expect(composed.find(row => row.id === 'jobs')?.disabled).toBe(true)
    expect(composed).toContainEqual({ id: 'monitor-jobs', name: 'dsh-tool-monitor/registry' })
    expect(composed).toContainEqual({ id: 'tool-monitor', name: 'dsh-tool-monitor/tool' })
    expect(composed.find(row => row.id === 'prime-code-runtime')?.name).toBe('dsh-prime-agent/runtime')
  })

  // Prime delegates adjacent-agent message scheduling to the 0.1.2-rc.1 base bundle.
  // Pin the composition boundary without duplicating the upstream tool implementation.
  // DSH 0.1.2-rc.1 retired the child-scoped `tool-subagent-report` row in favour of the
  // unified `send_message` on `tool-subagent-control`, which keeps the same
  // `Agent.steer()` nearest-step delivery for both directions.
  it('uses exactly one official adjacent-agent messaging row and no retired report row', async () => {
    const patches = load(await readFile(BASE_PATCH, 'utf8'), { schema: entryListSchema }) as Row[]
    const rows = patches.flatMap(patch => patch.insert ?? [])

    expect(rows.filter(row => row.id === 'tool-subagent-control')).toEqual([expect.objectContaining({
      name: '@deepseek-ai/dsh-tool-subagent-control',
    })])
    expect(rows.filter(row => row.id === 'tool-subagent-report')).toEqual([])

    // Prime composes the host-owned row; it never inserts a messaging tool of its own.
    const prime = await loadDialect('../cordis.patch.yml')
    const primeRows = prime.flatMap(patch => patch.insert ?? [])
    expect(primeRows.filter(row => String(row.name ?? '').includes('subagent'))).toEqual([])
  })

  it('ships the prompt dump script and scoped restriction export', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      files?: string[]
      exports?: Record<string, unknown>
    }
    expect(manifest.files).toContain('scripts/dump-prime-prompt.mjs')
    expect(manifest.files).toContain('skills')
    expect(manifest.exports).toHaveProperty('./tool-restrictions')
    expect(manifest.exports).toHaveProperty('./refine-skill-provider')
    const preset = await loadDialect('../agent-presets/prime/agent.cordis.yml')
    expect(preset).toContainEqual({
      id: 'prime-tool-restrictions',
      name: 'dsh-prime-agent/tool-restrictions',
      config: { deny: ['str_replace_editor', 'workflow', 'ralph'] },
    })
    expect(preset).toContainEqual({ id: 'prime-refine-skill', name: 'dsh-prime-agent/refine-skill-provider' })
    expect(preset.find(row => row.id === 'tool-skill')).toBeUndefined()
    expect(preset.find(row => row.id === 'tool-workflow')).toBeUndefined()
    expect(preset.find(row => row.id === 'tool-ralph')).toBeUndefined()
  })

  it('keeps the runtime and preset stateDirectory textually identical', async () => {
    const patches = await loadDialect('../cordis.patch.yml')
    const runtime = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'prime-code-runtime')
    const preset = (await loadDialect('../agent-presets/prime/agent.cordis.yml')).find(row => row.id === 'prime-agent')

    const runtimeExpr = stateDirectoryExpr(runtime)
    const presetExpr = stateDirectoryExpr(preset)
    expect(runtimeExpr).toBe("dshHomePath('prime-agent')")
    // Both services resolve the same trusted Session-to-Realm mapping.
    expect(presetExpr).toBe(runtimeExpr)
  })
})
