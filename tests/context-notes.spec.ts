import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskNotes } from '../src/context/notes.js'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'

let root: string | undefined
afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })
async function store() { root = await mkdtemp(join(tmpdir(), 'prime-notes-')); return new TaskNotes(root) }
const signal = new AbortController().signal
const update = (revision: number, content: string, updatedAtSessionOffset = 14) => ({
  revision,
  content,
  updatedAtSessionOffset: SessionLogOffset(updatedAtSessionOffset),
})

describe('session task notes', () => {
  it('survives reloading, isolates owners and clears with a new revision', async () => {
    const notes = await store()
    expect(await notes.read('parent')).toEqual({ revision: 0, content: '', updatedAtSessionOffset: null })
    await notes.write('parent', update(0, 'Goal and evidence seq 14'), signal)
    expect(await new TaskNotes(root!).read('parent')).toEqual({ revision: 1, content: 'Goal and evidence seq 14', updatedAtSessionOffset: 14 })
    expect(await notes.read('child')).toEqual({ revision: 0, content: '', updatedAtSessionOffset: null })
    await notes.write('parent', update(1, '', 20), signal)
    expect(await notes.read('parent')).toEqual({ revision: 2, content: '', updatedAtSessionOffset: 20 })
  })

  it('rejects one of two stale concurrent writers and releases the lock', async () => {
    const notes = await store()
    const results = await Promise.allSettled(['one', 'two'].map((text, index) => notes.write('owner', update(0, text, index), signal)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await notes.read('owner')).revision).toBe(1)
    await notes.write('owner', update(1, 'third', 3), signal)
    expect(await notes.read('owner')).toEqual({ revision: 2, content: 'third', updatedAtSessionOffset: 3 })
    expect((await readdir(join(root!, 'context-notes'))).filter(file => file.endsWith('.lock'))).toEqual([])
  })

  it('does not commit cancelled, oversized, or invalid updates', async () => {
    const notes = await store()
    await notes.write('owner', update(0, 'keep'), signal)
    await expect(notes.write('owner', update(1, 'drop'), AbortSignal.abort(new Error('cancel')))).rejects.toThrow('cancel')
    await expect(notes.write('owner', update(1, 'x'.repeat(6001)), signal)).rejects.toThrow()
    await expect(notes.write('owner', update(-1, 'drop'), signal)).rejects.toThrow()
    await expect(notes.write('owner', {
      ...update(1, 'drop'), updatedAtSessionOffset: -1 as SessionLogOffset,
    }, signal)).rejects.toThrow()
    await expect(notes.write('owner', {
      ...update(1, 'drop'), updatedAtSessionOffset: -0 as SessionLogOffset,
    }, signal)).rejects.toThrow()
    expect(await notes.read('owner')).toEqual({ revision: 1, content: 'keep', updatedAtSessionOffset: 14 })
  })

  it('fails closed on corrupt data and cannot use owner text as a filesystem path', async () => {
    const notes = await store()
    const owner = '../../escape'
    await notes.write(owner, update(0, 'safe'), signal)
    const files = await readdir(join(root!, 'context-notes'))
    expect(files).toHaveLength(1)
    const path = join(root!, 'context-notes', files[0]!)
    await writeFile(path, 'broken')
    await expect(notes.write(owner, update(1, 'lost'), signal)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('broken')
  })

  it('checks cancellation again after waiting for another writer', async () => {
    const notes = await store()
    await notes.write('owner', update(0, 'keep'), signal)
    const [file] = await readdir(join(root!, 'context-notes'))
    const path = join(root!, 'context-notes', file!)
    const acquired = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const holder = withFileLock(path, async () => { acquired.resolve(); await release.promise })
    await acquired.promise
    const controller = new AbortController()
    const waiting = notes.write('owner', update(1, 'drop'), controller.signal)
    controller.abort(new Error('cancel waiting'))
    release.resolve()
    await holder
    await expect(waiting).rejects.toThrow('cancel waiting')
    expect(await notes.read('owner')).toEqual({ revision: 1, content: 'keep', updatedAtSessionOffset: 14 })
  })

  it('reads legacy notes with unknown freshness and upgrades them on the next CAS write', async () => {
    const notes = await store()
    await notes.write('owner', update(0, 'initial'), signal)
    const [file] = await readdir(join(root!, 'context-notes'))
    const path = join(root!, 'context-notes', file!)
    await writeFile(path, JSON.stringify({ revision: 1, content: 'legacy' }))
    expect(await notes.read('owner')).toEqual({ revision: 1, content: 'legacy', updatedAtSessionOffset: null })
    await notes.write('owner', update(1, 'current', 29), signal)
    expect(await notes.read('owner')).toEqual({ revision: 2, content: 'current', updatedAtSessionOffset: 29 })
    await writeFile(path, JSON.stringify({ revision: 2, content: 'corrupt', updatedAtSessionOffset: -1 }))
    await expect(notes.read('owner')).rejects.toThrow('invalid task note')
    await expect(notes.write('owner', update(2, 'must not overwrite'), signal)).rejects.toThrow('invalid task note')
    await writeFile(path, '{"revision":2,"content":"corrupt","updatedAtSessionOffset":-0}')
    await expect(notes.read('owner')).rejects.toThrow('invalid task note')
  })
})
