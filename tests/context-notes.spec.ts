import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskNotes } from '../src/context/notes.js'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

let root: string | undefined
afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })
async function store() { root = await mkdtemp(join(tmpdir(), 'prime-notes-')); return new TaskNotes(root) }
const signal = new AbortController().signal

describe('session task notes', () => {
  it('survives reloading, isolates owners and clears with a new revision', async () => {
    const notes = await store()
    expect(await notes.read('parent')).toEqual({ revision: 0, content: '' })
    await notes.write('parent', 0, 'Goal and evidence seq 14', signal)
    expect(await new TaskNotes(root!).read('parent')).toEqual({ revision: 1, content: 'Goal and evidence seq 14' })
    expect(await notes.read('child')).toEqual({ revision: 0, content: '' })
    await notes.write('parent', 1, '', signal)
    expect(await notes.read('parent')).toEqual({ revision: 2, content: '' })
  })

  it('rejects one of two stale concurrent writers and releases the lock', async () => {
    const notes = await store()
    const results = await Promise.allSettled(['one', 'two'].map(text => notes.write('owner', 0, text, signal)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await notes.read('owner')).revision).toBe(1)
    await notes.write('owner', 1, 'third', signal)
    expect(await notes.read('owner')).toEqual({ revision: 2, content: 'third' })
    expect((await readdir(join(root!, 'context-notes'))).filter(file => file.endsWith('.lock'))).toEqual([])
  })

  it('does not commit cancelled, oversized, or invalid updates', async () => {
    const notes = await store()
    await notes.write('owner', 0, 'keep', signal)
    await expect(notes.write('owner', 1, 'drop', AbortSignal.abort(new Error('cancel')))).rejects.toThrow('cancel')
    await expect(notes.write('owner', 1, 'x'.repeat(6001), signal)).rejects.toThrow()
    await expect(notes.write('owner', -1, 'drop', signal)).rejects.toThrow()
    expect(await notes.read('owner')).toEqual({ revision: 1, content: 'keep' })
  })

  it('fails closed on corrupt data and cannot use owner text as a filesystem path', async () => {
    const notes = await store()
    const owner = '../../escape'
    await notes.write(owner, 0, 'safe', signal)
    const files = await readdir(join(root!, 'context-notes'))
    expect(files).toHaveLength(1)
    const path = join(root!, 'context-notes', files[0]!)
    await writeFile(path, 'broken')
    await expect(notes.write(owner, 1, 'lost', signal)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('broken')
  })

  it('checks cancellation again after waiting for another writer', async () => {
    const notes = await store()
    await notes.write('owner', 0, 'keep', signal)
    const [file] = await readdir(join(root!, 'context-notes'))
    const path = join(root!, 'context-notes', file!)
    const acquired = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const holder = withFileLock(path, async () => { acquired.resolve(); await release.promise })
    await acquired.promise
    const controller = new AbortController()
    const waiting = notes.write('owner', 1, 'drop', controller.signal)
    controller.abort(new Error('cancel waiting'))
    release.resolve()
    await holder
    await expect(waiting).rejects.toThrow('cancel waiting')
    expect(await notes.read('owner')).toEqual({ revision: 1, content: 'keep' })
  })
})
