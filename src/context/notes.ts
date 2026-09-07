import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export interface TaskNote { revision: number; content: string }

/** One bounded, session-owned task note. File publication and cross-process locking belong to DSH. */
export class TaskNotes {
  private readonly directory: string
  constructor(directory: string) {
    if (directory.trim().length === 0) throw new Error('task notes require a state directory')
    this.directory = directory
  }

  private path(owner: string): string {
    if (owner.length === 0) throw new Error('notes require an owning session')
    return join(this.directory, 'context-notes', `${createHash('sha256').update(owner).digest('hex')}.json`)
  }

  async read(owner: string): Promise<TaskNote> {
    let text: string
    try { text = await readFile(this.path(owner), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, content: '' }
      throw error
    }
    const note: unknown = JSON.parse(text)
    if (typeof note !== 'object' || note === null || !('revision' in note) || !('content' in note)
      || !Number.isSafeInteger(note.revision) || (note.revision as number) < 0
      || typeof note.content !== 'string' || note.content.length > 6000) throw new Error('invalid task note; refusing to overwrite it')
    return { revision: note.revision as number, content: note.content }
  }

  async write(owner: string, revision: number, content: string, signal: AbortSignal): Promise<TaskNote> {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('revision must be a non-negative safe integer below the maximum')
    if (content.length > 6000) throw new Error('keep task notes within 6000 characters; store large evidence in task files')
    signal.throwIfAborted()
    const path = this.path(owner)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    return withFileLock(path, async () => {
      signal.throwIfAborted()
      const current = await this.read(owner)
      if (current.revision !== revision) throw new Error(`notes changed (revision ${current.revision}); read them again before writing`)
      const note = { revision: revision + 1, content }
      signal.throwIfAborted()
      await writeFileAtomic(path, JSON.stringify(note), { mode: 0o600, dirMode: 0o700 })
      return note
    })
  }
}
