import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'

export interface TaskNote {
  revision: number
  content: string
  /** Exclusive Session log offset observed when this revision was written; null for legacy or absent notes. */
  updatedAtSessionOffset: SessionLogOffset | null
}

export interface TaskNoteUpdate {
  revision: number
  content: string
  /** Trusted exclusive Session log offset supplied by the owning Host context. */
  updatedAtSessionOffset: SessionLogOffset
}

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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, content: '', updatedAtSessionOffset: null }
      throw error
    }
    const note: unknown = JSON.parse(text)
    if (typeof note !== 'object' || note === null || !('revision' in note) || !('content' in note)
      || !Number.isSafeInteger(note.revision) || (note.revision as number) < 0
      || typeof note.content !== 'string' || note.content.length > 6000) throw new Error('invalid task note; refusing to overwrite it')
    const storedOffset = 'updatedAtSessionOffset' in note ? note.updatedAtSessionOffset : null
    let updatedAtSessionOffset: SessionLogOffset | null = null
    if (storedOffset !== null) {
      try {
        if (typeof storedOffset !== 'number') throw new TypeError('not a number')
        updatedAtSessionOffset = SessionLogOffset(storedOffset)
      } catch {
        throw new Error('invalid task note; refusing to overwrite it')
      }
    }
    return { revision: note.revision as number, content: note.content, updatedAtSessionOffset }
  }

  async write(owner: string, update: TaskNoteUpdate, signal: AbortSignal): Promise<TaskNote> {
    if (!Number.isSafeInteger(update.revision) || update.revision < 0 || update.revision >= Number.MAX_SAFE_INTEGER) throw new Error('revision must be a non-negative safe integer below the maximum')
    const updatedAtSessionOffset = SessionLogOffset(update.updatedAtSessionOffset)
    if (update.content.length > 6000) throw new Error('keep task notes within 6000 characters; store large evidence in task files')
    signal.throwIfAborted()
    const path = this.path(owner)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    return withFileLock(path, async () => {
      signal.throwIfAborted()
      const current = await this.read(owner)
      if (current.revision !== update.revision) throw new Error(`notes changed (revision ${current.revision}); read them again before writing`)
      const note: TaskNote = {
        revision: update.revision + 1,
        content: update.content,
        updatedAtSessionOffset,
      }
      signal.throwIfAborted()
      await writeFileAtomic(path, JSON.stringify(note), { mode: 0o600, dirMode: 0o700 })
      return note
    })
  }
}
