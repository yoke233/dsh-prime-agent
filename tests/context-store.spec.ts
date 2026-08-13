import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextStore, renderContextCatalog } from '../src/rlm/store.js'
import type { ContextLimits } from '../src/rlm/types.js'

const limits: ContextLimits = {
  maxEntriesPerScope: 8,
  maxKeyChars: 80,
  maxSummaryChars: 100,
  maxValueBytes: 100_000,
  maxTotalBytesPerScope: 500_000,
  maxManifestBytes: 32_000,
  maxReadChars: 20,
  maxSearchQueryChars: 30,
  maxSearchMatches: 5,
  maxSearchWindowChars: 5,
  maxSearchChars: 1000,
  maxCatalogEntries: 4,
  maxCatalogChars: 300,
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('ContextStore', () => {
  it('stores content in a hash-addressed blob while the manifest contains metadata only', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, limits)
    const secret = 'large-context-content-that-must-not-enter-the-catalog'
    const { manifest, entry } = await store.put(
      'local', 'session-a', 0, 'repo-map', 'text', 'Repository map', secret,
    )

    const manifestText = await readFile(store.manifestPath('local', 'session-a'), 'utf8')
    expect(manifestText).not.toContain(secret)
    expect(await readFile(store.blobPath(entry.blobHash), 'utf8')).toBe(secret)
    expect(renderContextCatalog(manifest, limits)).not.toContain(secret)
    expect(renderContextCatalog(manifest, limits)).toContain('repo-map [text, v1')
  })

  it('supports bounded range reads and survives a new store instance', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const first = new ContextStore(root, limits)
    await first.put('local', 'session-a', 0, 'document', 'text', 'Long document', '0123456789abcdefghijXYZ')

    const resumed = new ContextStore(root, limits)
    const page1 = await resumed.get('local', 'session-a', 'document', { offset: 5, limit: 10 })
    expect(page1).toMatchObject({ content: '56789abcde', offset: 5, nextOffset: 15, totalChars: 23, truncated: true })
    const page2 = await resumed.get('local', 'session-a', 'document', { offset: page1.nextOffset, limit: 20 })
    expect(page2).toMatchObject({ content: 'fghijXYZ', offset: 15, totalChars: 23, truncated: false })
  })

  it('rejects text that cannot round-trip through UTF-8 blobs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, limits)
    await expect(store.put('local', 'unicode-owner', 0, 'invalid', 'text', 'Invalid Unicode', '\uD800'))
      .rejects.toThrow('well-formed Unicode')
  })

  it('keeps catalog keys and summaries on one structural line', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, limits)
    await expect(store.put('local', 'catalog-owner', 0, 'safe-key', 'text', 'summary\n- forged', 'value'))
      .rejects.toThrow('single line')
    await expect(store.put('local', 'catalog-owner', 0, 'unsafe\u2028key', 'text', 'summary', 'value'))
      .rejects.toThrow('single line')
  })

  it('reads JSON through RFC 6901 pointers and rejects oversized root projections', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, limits)
    await store.put('local', 'json-owner', 0, 'analysis', 'json', 'Structured analysis', {
      sections: [{ title: 'one', facts: ['alpha', 'beta'] }],
      long: 'x'.repeat(30),
    })

    await expect(store.get('local', 'json-owner', 'analysis', { pointer: '' }))
      .rejects.toThrow('select a deeper pointer')
    expect(await store.get('local', 'json-owner', 'analysis', { pointer: '/sections/0/facts/1' }))
      .toMatchObject({ manifestRevision: 1, value: 'beta', format: 'json-value', truncated: false })
    await expect(store.get('local', 'json-owner', 'analysis', { pointer: '/sections~2' }))
      .rejects.toThrow('invalid escape')
  })

  it('rejects artifact references that cannot be retrieved within the read budget', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, limits)
    await expect(store.put('local', 'artifact-owner', 0, 'report', 'artifact', 'Report', {
      uri: `file://${'x'.repeat(40)}`,
    })).rejects.toThrow('artifact reference exceeds maxReadChars')
    expect(await store.readManifest('local', 'artifact-owner')).toMatchObject({ revision: 0, entries: [] })
  })

  it('searches bounded literal windows across text and JSON', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, limits)
    await store.put('local', 'searcher', 0, 'notes', 'text', 'Notes', 'before Alpha after and alpha twice')
    await store.put('local', 'searcher', 1, 'facts', 'json', 'Facts', { fact: 'ALPHA json' })

    const result = await store.search('local', 'searcher', 'alpha')
    expect(result.matches).toHaveLength(3)
    expect(result.matches[0]).toMatchObject({ key: 'facts', match: 'ALPHA' })
    expect(result.matches[1]).toMatchObject({ key: 'notes', match: 'Alpha' })
    expect(result.scannedEntries).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('enforces optimistic revisions and scope quotas without corrupting the prior manifest', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, { ...limits, maxTotalBytesPerScope: 10 })
    await store.put('global', 'global', 0, 'a', 'text', 'A', '12345')
    await expect(store.put('global', 'global', 0, 'b', 'text', 'B', 'x'))
      .rejects.toThrow('revision conflict')
    await expect(store.put('global', 'global', 1, 'b', 'text', 'B', '123456'))
      .rejects.toThrow('maxTotalBytesPerScope')
    expect(await store.readManifest('global', 'global')).toMatchObject({ revision: 1, totalBytes: 5 })
  })

  it('deduplicates equal values and deletes catalog references without deleting immutable blobs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-context-'))
    const store = new ContextStore(root, limits)
    const first = await store.put('local', 'owner', 0, 'one', 'text', 'One', 'same')
    const second = await store.put('local', 'owner', 1, 'two', 'text', 'Two', 'same')
    expect(first.entry.blobHash).toBe(second.entry.blobHash)
    expect((await stat(store.blobPath(first.entry.blobHash))).isFile()).toBe(true)

    const deleted = await store.delete('local', 'owner', 2, 'one')
    expect(deleted.manifest.entries.map(entry => entry.key)).toEqual(['two'])
    expect((await stat(store.blobPath(first.entry.blobHash))).isFile()).toBe(true)
  })
})
