import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
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

  it('replaces only the code runtime', async () => {
    const patches = await loadDialect('../cordis.patch.yml')
    expect(patches).toHaveLength(2)

    const [retireRuntime, insertRuntime] = patches
    // The name is a patch-layer assertion: a deployment that replaced the
    // official row keeps its own provider instead of having it disabled.
    expect(retireRuntime).toEqual({
      id: 'code-runtime',
      name: '@deepseek-ai/dsh-code-runtime-worker-thread',
      disabled: true,
    })

    expect(insertRuntime?.insert).toHaveLength(1)
    const runtime = insertRuntime?.insert?.[0]
    expect(runtime?.id).toBe('prime-code-runtime')
    expect(runtime?.name).toBe('dsh-prime-agent/runtime')
    // Budgets stay unset so the official schema keeps supplying its defaults
    // for the privately mounted fallback.
    expect(Object.keys(runtime?.config ?? {})).toEqual(['stateDirectory'])

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

  it('keeps the runtime and preset stateDirectory textually identical', async () => {
    const patches = await loadDialect('../cordis.patch.yml')
    const runtime = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'prime-code-runtime')
    const preset = (await loadDialect('../agent-presets/prime/agent.cordis.yml')).find(row => row.id === 'prime-agent')

    const runtimeExpr = stateDirectoryExpr(runtime)
    const presetExpr = stateDirectoryExpr(preset)
    expect(runtimeExpr).toBe("dshHomePath('prime-agent')")
    // Both sides open the same `realm-identity/hmac.key`; a textual divergence
    // here is a handshake that always fails closed at runtime.
    expect(presetExpr).toBe(runtimeExpr)
  })
})
