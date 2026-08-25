import {
  PATCH_ERROR_CODES,
  PatchError,
  type ParsedPatch,
  type ParsedUpdateFile,
  type ParsedUpdateHunk,
  type PatchPlan,
} from './types.js'

interface TextLayout {
  lines: string[]
  newline: '\n' | '\r\n'
  trailingNewline: boolean
}

/** Compute every final file body without performing any mutation. */
export function planPatch(parsed: ParsedPatch, snapshots: ReadonlyMap<string, string | null>): PatchPlan {
  rejectUnsupportedOperations(parsed)

  const files: PatchPlan['files'] = []
  for (const file of parsed.files) {
    if (!snapshots.has(file.path)) {
      throw new PatchError(
        PATCH_ERROR_CODES.snapshotMissing,
        `No preflight snapshot was provided for '${file.path}'.`,
        { path: file.path },
      )
    }
    const snapshot = snapshots.get(file.path)

    if (file.operation === 'add') {
      if (snapshot !== null) {
        throw new PatchError(PATCH_ERROR_CODES.targetExists, `Cannot add '${file.path}' because it already exists.`, {
          path: file.path,
        })
      }
      files.push({
        path: file.path,
        operation: 'add',
        content: `${file.lines.join('\n')}\n`,
        hunks: 1,
      })
      continue
    }

    if (file.operation !== 'update') {
      throw new PatchError(PATCH_ERROR_CODES.unsupportedOperation, `Delete File is not supported for '${file.path}'.`, {
        path: file.path,
      })
    }
    if (snapshot === null) {
      throw new PatchError(PATCH_ERROR_CODES.fileNotFound, `Cannot update '${file.path}' because it does not exist.`, {
        path: file.path,
      })
    }
    if (snapshot === undefined) {
      throw new PatchError(
        PATCH_ERROR_CODES.snapshotMissing,
        `No preflight snapshot was provided for '${file.path}'.`,
        { path: file.path },
      )
    }

    files.push({
      path: file.path,
      operation: 'update',
      content: applyUpdate(file, snapshot),
      hunks: file.hunks.length,
    })
  }
  return { files }
}

function rejectUnsupportedOperations(parsed: ParsedPatch): void {
  for (const file of parsed.files) {
    if (file.operation === 'delete') {
      throw new PatchError(PATCH_ERROR_CODES.unsupportedOperation, `Delete File is not supported for '${file.path}'.`, {
        path: file.path,
      })
    }
    if (file.operation === 'update' && file.movePath !== null) {
      throw new PatchError(
        PATCH_ERROR_CODES.unsupportedOperation,
        `Move to '${file.movePath}' is not supported for '${file.path}'.`,
        { path: file.path },
      )
    }
  }
}

function applyUpdate(file: ParsedUpdateFile, snapshot: string): string {
  const layout = splitText(snapshot)
  let cursor = 0

  for (const hunk of file.hunks) {
    const anchor = resolveContext(file.path, hunk, layout.lines, cursor)
    const position = resolveOldLines(file.path, hunk, layout.lines, anchor, cursor)
    layout.lines.splice(position, hunk.oldLines.length, ...hunk.newLines)
    cursor = position + hunk.newLines.length
  }

  return joinText(layout)
}

function resolveContext(
  path: string,
  hunk: ParsedUpdateHunk,
  lines: readonly string[],
  cursor: number,
): number {
  if (hunk.context === null) return cursor

  const remaining = lineOccurrences(lines, hunk.context, cursor)
  if (remaining.length === 0) {
    if (lineOccurrences(lines, hunk.context, 0, cursor).length > 0) {
      throw hunkError(
        PATCH_ERROR_CODES.hunkOutOfOrder,
        path,
        `Context '${hunk.context}' for '${path}' occurs before the preceding hunk.`,
      )
    }
    throw hunkError(PATCH_ERROR_CODES.contextNotFound, path, `Context '${hunk.context}' was not found in '${path}'.`)
  }
  if (remaining.length > 1) {
    throw hunkError(
      PATCH_ERROR_CODES.contextAmbiguous,
      path,
      `Context '${hunk.context}' is ambiguous in '${path}' (${remaining.length} matches).`,
    )
  }
  const match = remaining[0]
  if (match === undefined) throw new Error('unreachable context match')
  return match + 1
}

function resolveOldLines(
  path: string,
  hunk: ParsedUpdateHunk,
  lines: readonly string[],
  start: number,
  cursor: number,
): number {
  if (hunk.oldLines.length === 0) return hunk.endOfFile ? lines.length : start

  if (hunk.endOfFile) {
    const position = lines.length - hunk.oldLines.length
    if (position >= start && sequenceMatches(lines, hunk.oldLines, position)) return position
    if (position >= 0 && position < cursor && sequenceMatches(lines, hunk.oldLines, position)) {
      throw hunkError(PATCH_ERROR_CODES.hunkOutOfOrder, path, `An End of File hunk for '${path}' is out of order.`)
    }
    throw hunkError(
      PATCH_ERROR_CODES.contextNotFound,
      path,
      `The expected End of File lines were not found in '${path}'.`,
    )
  }

  const matches = sequenceOccurrences(lines, hunk.oldLines, start)
  if (matches.length === 0) {
    if (sequenceOccurrences(lines, hunk.oldLines, 0, cursor).length > 0) {
      throw hunkError(PATCH_ERROR_CODES.hunkOutOfOrder, path, `A hunk for '${path}' occurs before the preceding hunk.`)
    }
    throw hunkError(PATCH_ERROR_CODES.contextNotFound, path, `Expected hunk context was not found in '${path}'.`)
  }
  if (matches.length > 1) {
    throw hunkError(
      PATCH_ERROR_CODES.contextAmbiguous,
      path,
      `Expected hunk context is ambiguous in '${path}' (${matches.length} matches).`,
    )
  }
  const match = matches[0]
  if (match === undefined) throw new Error('unreachable hunk match')
  return match
}

function splitText(content: string): TextLayout {
  const firstLf = content.indexOf('\n')
  const newline: '\n' | '\r\n' = firstLf > 0 && content[firstLf - 1] === '\r' ? '\r\n' : '\n'
  const trailingNewline = content.endsWith('\n')
  if (content === '') return { lines: [], newline, trailingNewline: false }

  const lines = content.split(/\r\n|\n/)
  if (trailingNewline) lines.pop()
  return { lines, newline, trailingNewline }
}

function joinText(layout: TextLayout): string {
  if (layout.lines.length === 0) return ''
  const body = layout.lines.join(layout.newline)
  return layout.trailingNewline ? body + layout.newline : body
}

function lineOccurrences(lines: readonly string[], expected: string, start: number, end = lines.length): number[] {
  const matches: number[] = []
  for (let index = start; index < end; index += 1) {
    if (lines[index] === expected) matches.push(index)
  }
  return matches
}

function sequenceOccurrences(lines: readonly string[], expected: readonly string[], start: number, end = lines.length): number[] {
  const matches: number[] = []
  const lastStart = Math.min(end, lines.length - expected.length)
  for (let index = start; index <= lastStart; index += 1) {
    if (sequenceMatches(lines, expected, index)) matches.push(index)
  }
  return matches
}

function sequenceMatches(lines: readonly string[], expected: readonly string[], start: number): boolean {
  if (start < 0 || start + expected.length > lines.length) return false
  return expected.every((line, offset) => lines[start + offset] === line)
}

function hunkError(code: 'CONTEXT_NOT_FOUND' | 'CONTEXT_AMBIGUOUS' | 'HUNK_OUT_OF_ORDER', path: string, message: string): PatchError {
  return new PatchError(code, message, { path })
}
