import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'

interface Row { id?: string; name?: string; disabled?: unknown; config?: Record<string, unknown>; insert?: Row[] }

async function loadDialect(path: string): Promise<Row[]> {
  return load(await readFile(resolve(import.meta.dirname, path), 'utf8'), { schema: entryListSchema }) as Row[]
}

/** The `!!js` source of one row's `stateDirectory`, or undefined. */
function stateDirectoryExpr(row: Row | undefined): string | undefined {
  const value = row?.config?.stateDirectory
  return isJsExpr(value) ? (value as { __jsExpr: string }).__jsExpr : undefined
}

describe('Prime packaging boundary', () => {
  it('ships the official one-shot runtime as production dependencies', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, unknown>
    }
    const runtimePackages = ['@deepseek-ai/dsh-code-runtime']

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

  // Prime delegates report scheduling to the 0.1.1-rc.2 base bundle. Pin the
  // composition boundary without duplicating the upstream tool implementation.
  const BASE_PATCH = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-base/cordis.patch.yml')
  it('uses exactly one official tool-subagent-report row', async () => {
    const patches = load(await readFile(BASE_PATCH, 'utf8'), { schema: entryListSchema }) as Row[]
    const reports = patches.flatMap(patch => patch.insert ?? [])
      .filter(row => row.id === 'tool-subagent-report')
    expect(reports).toEqual([expect.objectContaining({
      name: '@deepseek-ai/dsh-tool-subagent-report',
    })])
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
      config: { deny: ['str_replace_editor', 'workflow'] },
    })
    expect(preset).toContainEqual({ id: 'prime-refine-skill', name: 'dsh-prime-agent/refine-skill-provider' })
    expect(preset.find(row => row.id === 'tool-skill')).toBeUndefined()
    expect(preset.find(row => row.id === 'tool-workflow')).toBeUndefined()
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
