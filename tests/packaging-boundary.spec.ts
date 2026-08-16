import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
  it('carries exactly the two swaps and nothing else', async () => {
    const patches = await loadDialect('../cordis.patch.yml')
    // Two independent pairs: the code-runtime swap and the subagent-report swap.
    expect(patches).toHaveLength(4)

    const [retireRuntime, insertRuntime, retireReport, insertReport] = patches
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

    // The host report tool is retired so continuable children see only the
    // Prime-form one; the name assertion protects a deployment that swapped it.
    expect(retireReport).toEqual({
      id: 'tool-subagent-report',
      name: '@deepseek-ai/dsh-tool-subagent-report',
      disabled: true,
    })

    expect(insertReport?.insert).toHaveLength(1)
    const report = insertReport?.insert?.[0]
    expect(report?.id).toBe('prime-subagent-report')
    expect(report?.name).toBe('dsh-prime-agent/subagent-report')
    // No config: delivery is chosen per call from the parent's live status.
    expect(report?.config).toBeUndefined()
  })

  // The disable of `tool-subagent-report` only lands while the upstream base
  // bundle keeps that row top-level under its one root insert, with this exact
  // id and name. If it drifts, the disable silently skips while the insert
  // still lands, and every continuable child fails on a duplicate `report`
  // registration (diagnosed at runtime by dsh-prime-agent/subagent-report).
  // Pin the target here so the upstream sync catches the drift first.
  const BASE_PATCH = resolve(import.meta.dirname, '../../deepseek-harness/packages/bundle/base/cordis.patch.yml')
  it.skipIf(!existsSync(BASE_PATCH))('pins the upstream tool-subagent-report row the disable targets', async () => {
    const patches = load(await readFile(BASE_PATCH, 'utf8'), { schema: entryListSchema }) as Row[]
    const rows = patches.flatMap(patch => patch.insert ?? [])
    const report = rows.find(row => row.id === 'tool-subagent-report')
    expect(report).toBeDefined()
    expect(report?.name).toBe('@deepseek-ai/dsh-tool-subagent-report')
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
