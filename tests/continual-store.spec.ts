import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessStore, renderHarnessState } from '../src/continual/store.js'
import type { HarnessLimits } from '../src/continual/types.js'

const limits: HarnessLimits = {
  maxEntriesPerScope: 8,
  maxEntryIdChars: 128,
  maxEntryTitleChars: 200,
  maxEntryContentChars: 500,
  maxReferenceToolChars: 128,
  maxEvidenceItems: 4,
  maxEvidenceChars: 200,
  maxEditsPerTransaction: 4,
  maxTransactions: 8,
  maxStateBytes: 64 * 1024,
  maxPromptEntriesPerScope: 4,
  maxPromptCharsPerScope: 2000,
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('HarnessStore', () => {
  it('commits an evidence-backed edit and rolls it back', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-store-'))
    const store = new HarnessStore(root, limits)
    const applied = await store.apply(
      'local',
      'session-a',
      0,
      'The same correction was needed twice.',
      ['turn 2 correction', 'turn 5 correction'],
      'The correction is recalled before the next matching action.',
      [{ action: 'create', kind: 'memory', id: 'stable-format', title: 'Stable format', content: 'Preserve the caller-provided field order.' }],
    )

    expect(applied.state.revision).toBe(1)
    expect(applied.state.entries).toHaveLength(1)
    await expect(store.apply(
      'local', 'session-a', 0, 'stale', ['stale'], 'reject stale writes',
      [{ action: 'delete', kind: 'memory', id: 'stable-format' }],
    )).rejects.toThrow('revision conflict')

    const rolledBack = await store.rollback('local', 'session-a', 1, applied.transaction.id)
    expect(rolledBack.state.revision).toBe(2)
    expect(rolledBack.state.entries).toEqual([])
    expect(rolledBack.transaction.rollbackOf).toBe(applied.transaction.id)
  })

  it('requires real callable references for skill entries', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-store-'))
    const store = new HarnessStore(root, limits)
    await expect(store.apply(
      'global', 'global', 0, 'Reusable route', ['Repeated discovery'], 'Use the route directly',
      [{ action: 'create', kind: 'skill', id: 'research', title: 'Research', content: 'Use the research route.' }],
    )).rejects.toThrow('requires a callable reference')
  })

  it('renders bounded model context with callable syntax', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-store-'))
    const store = new HarnessStore(root, limits)
    const { state } = await store.apply(
      'global', 'global', 0, 'Reusable delegation', ['Successful delegation'], 'Delegate matching work',
      [{
        action: 'create', kind: 'subagent', id: 'repo-review', title: 'Repository review',
        content: 'Delegate bounded repository review tasks.',
        reference: { tool: 'subagent', arguments: { task: '<bounded review>' } },
      }],
    )
    expect(renderHarnessState(state, limits)).toContain('tools.subagent({"task":"<bounded review>"})')
  })

  it('keeps rollback metadata readable under a one-character evidence limit', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-store-'))
    const tinyLimits = { ...limits, maxEvidenceChars: 1 }
    const store = new HarnessStore(root, tinyLimits)
    const applied = await store.apply(
      'local', 'tiny', 0, 'T', ['E'], 'O',
      [{ action: 'create', kind: 'memory', id: 'x', title: 'X', content: 'X' }],
    )

    await store.rollback('local', 'tiny', 1, applied.transaction.id)
    const reread = await store.read('local', 'tiny')
    expect(reread.revision).toBe(2)
    expect(reread.transactions.at(-1)).toMatchObject({
      type: 'rollback', trigger: 'R', evidence: ['N'], expectedOutcome: 'R',
    })
  })

  it('stores the normalized callable tool name', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-store-'))
    const store = new HarnessStore(root, limits)
    const { state } = await store.apply(
      'local', 'normalized', 0, 'Route', ['Works'], 'Reuse',
      [{
        action: 'create', kind: 'skill', id: 'search', title: 'Search', content: 'Search first.',
        reference: { tool: '  web_search  ', arguments: { query: '<query>' } },
      }],
    )

    expect(state.entries[0]?.reference?.tool).toBe('web_search')
    expect(renderHarnessState(state, limits)).toContain('tools.web_search(')
  })

  it('rejects restoring a historical snapshot that exceeds tightened limits', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-store-'))
    const broad = new HarnessStore(root, limits)
    const created = await broad.apply(
      'local', 'tightened', 0, 'Create', ['Large'], 'Retain',
      [{ action: 'create', kind: 'memory', id: 'sized', title: 'Sized', content: '1234567890' }],
    )
    const updated = await broad.apply(
      'local', 'tightened', 1, 'Shrink', ['Small'], 'Fit',
      [{ action: 'update', kind: 'memory', id: 'sized', title: 'Sized', content: '1234' }],
    )
    const tightened = new HarnessStore(root, { ...limits, maxEntryContentChars: 4 })

    expect((await tightened.read('local', 'tightened')).revision).toBe(2)
    await expect(tightened.rollback('local', 'tightened', 2, updated.transaction.id))
      .rejects.toThrow('rollback snapshot memory:sized has invalid or oversized content')
    expect((await tightened.read('local', 'tightened')).revision).toBe(2)
    expect(created.state.entries[0]?.content).toBe('1234567890')
  })
})
