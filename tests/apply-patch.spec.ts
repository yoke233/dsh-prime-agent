import { describe, expect, it } from 'vitest'
import { parsePatch } from '../src/apply-patch/parser.js'
import { planPatch } from '../src/apply-patch/planner.js'
import { PATCH_ERROR_CODES, PatchError, type PatchErrorCode } from '../src/apply-patch/types.js'

function patch(lines: readonly string[], newline = '\n'): string {
  return lines.join(newline)
}

function expectPatchError(run: () => unknown, code: PatchErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PatchError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`Expected PatchError ${code}.`)
}

describe('parsePatch and planPatch', () => {
  it('plans an added file and preserves literal backticks and interpolation syntax', () => {
    const sourceLine = 'export const greeting = `hello ${name}`'
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Add File: src/greeting.ts',
      `+${sourceLine}`,
      '+',
      '*** End Patch',
    ]))

    expect(parsed.files).toEqual([{
      operation: 'add',
      path: 'src/greeting.ts',
      lines: [sourceLine, ''],
    }])
    expect(planPatch(parsed, new Map([['src/greeting.ts', null]]))).toEqual({
      files: [{
        path: 'src/greeting.ts',
        operation: 'add',
        content: `${sourceLine}\n\n`,
        hunks: 1,
      }],
    })
  })

  it('plans multiple files only after all snapshots are available', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+new',
      '*** Update File: old.txt',
      '@@',
      '-old',
      '+updated',
      '*** End Patch',
    ]))

    expect(planPatch(parsed, new Map([
      ['new.txt', null],
      ['old.txt', 'old\n'],
    ]))).toEqual({
      files: [
        { path: 'new.txt', operation: 'add', content: 'new\n', hunks: 1 },
        { path: 'old.txt', operation: 'update', content: 'updated\n', hunks: 1 },
      ],
    })
    expectPatchError(
      () => planPatch(parsed, new Map([['new.txt', null]])),
      PATCH_ERROR_CODES.snapshotMissing,
    )
  })

  it('applies ordered named hunks and an End of File constraint', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: functions.ts',
      '@@ function one() {',
      '-  return 1',
      '+  return 10',
      '@@ function two() {',
      '-  return 2',
      '+  return 20',
      ' }',
      '*** End of File',
      '*** End Patch',
    ]))
    const source = [
      'function one() {',
      '  return 1',
      '}',
      '',
      'function two() {',
      '  return 2',
      '}',
      '',
    ].join('\n')

    expect(planPatch(parsed, new Map([['functions.ts', source]]))).toEqual({
      files: [{
        path: 'functions.ts',
        operation: 'update',
        content: source.replace('return 1', 'return 10').replace('return 2', 'return 20'),
        hunks: 2,
      }],
    })
  })

  it('accepts CRLF patch syntax and preserves CRLF source layout', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: windows.txt',
      '@@',
      ' before',
      '-old',
      '+new',
      ' after',
      '*** End Patch',
    ], '\r\n'))

    expect(planPatch(parsed, new Map([['windows.txt', 'before\r\nold\r\nafter\r\n']]))).toEqual({
      files: [{
        path: 'windows.txt',
        operation: 'update',
        content: 'before\r\nnew\r\nafter\r\n',
        hunks: 1,
      }],
    })
  })

  it('preserves the absence of a trailing newline', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: no-eof-newline.txt',
      '@@',
      '-last',
      '+changed',
      '*** End of File',
      '*** End Patch',
    ]))

    expect(planPatch(parsed, new Map([['no-eof-newline.txt', 'first\nlast']])).files[0]?.content)
      .toBe('first\nchanged')
  })

  it('produces an empty file when a hunk removes its only line', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: empty.txt',
      '@@',
      '-only line',
      '*** End Patch',
    ]))

    expect(planPatch(parsed, new Map([['empty.txt', 'only line\n']])).files[0]?.content).toBe('')
  })

  it('rejects missing and ambiguous strict context', () => {
    const missing = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: sample.txt',
      '@@ absent anchor',
      '-old',
      '+new',
      '*** End Patch',
    ]))
    expectPatchError(
      () => planPatch(missing, new Map([['sample.txt', 'old\n']])),
      PATCH_ERROR_CODES.contextNotFound,
    )

    const ambiguous = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: sample.txt',
      '@@',
      '-same',
      '+changed',
      '*** End Patch',
    ]))
    expectPatchError(
      () => planPatch(ambiguous, new Map([['sample.txt', 'same\nmiddle\nsame\n']])),
      PATCH_ERROR_CODES.contextAmbiguous,
    )
  })

  it('rejects hunks that move backwards through a file', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: ordered.txt',
      '@@',
      '-beta',
      '+BETA',
      '@@',
      '-alpha',
      '+ALPHA',
      '*** End Patch',
    ]))

    expectPatchError(
      () => planPatch(parsed, new Map([['ordered.txt', 'alpha\nbeta\n']])),
      PATCH_ERROR_CODES.hunkOutOfOrder,
    )
  })

  it('rejects bare update lines without a patch prefix', () => {
    expectPatchError(
      () => parsePatch(patch([
        '*** Begin Patch',
        '*** Update File: strict.txt',
        '@@',
        '',
        '-old',
        '+new',
        '*** End Patch',
      ])),
      PATCH_ERROR_CODES.invalidHunk,
    )
  })

  it.each([
    '',
    '/absolute.txt',
    'C:\\absolute.txt',
    '../escape.txt',
    'dir/../escape.txt',
    '\\server\\share.txt',
    'nul\0byte.txt',
  ])('rejects unsafe path %j', unsafePath => {
    expectPatchError(
      () => parsePatch(patch([
        '*** Begin Patch',
        `*** Add File: ${unsafePath}`,
        '+content',
        '*** End Patch',
      ])),
      PATCH_ERROR_CODES.invalidPath,
    )
  })

  it('normalizes separators and rejects duplicate source paths', () => {
    expectPatchError(
      () => parsePatch(patch([
        '*** Begin Patch',
        '*** Add File: src\\same.txt',
        '+first',
        '*** Update File: src/./same.txt',
        '@@',
        '-first',
        '+second',
        '*** End Patch',
      ])),
      PATCH_ERROR_CODES.duplicatePath,
    )
  })

  it('parses Delete File but planner rejects it with a stable unsupported error', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Delete File: obsolete.txt',
      '*** End Patch',
    ]))

    expect(parsed.files).toEqual([{ operation: 'delete', path: 'obsolete.txt' }])
    expectPatchError(
      () => planPatch(parsed, new Map([['obsolete.txt', 'old\n']])),
      PATCH_ERROR_CODES.unsupportedOperation,
    )
  })

  it('parses Move to but planner rejects it with a stable unsupported error', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: before.txt',
      '*** Move to: after.txt',
      '*** End Patch',
    ]))

    expect(parsed.files).toEqual([{
      operation: 'update',
      path: 'before.txt',
      movePath: 'after.txt',
      hunks: [],
    }])
    expectPatchError(
      () => planPatch(parsed, new Map([['before.txt', 'content\n']])),
      PATCH_ERROR_CODES.unsupportedOperation,
    )
  })

  it('requires Add targets to be absent and Update targets to exist', () => {
    const add = parsePatch(patch([
      '*** Begin Patch',
      '*** Add File: exists.txt',
      '+new',
      '*** End Patch',
    ]))
    expectPatchError(
      () => planPatch(add, new Map([['exists.txt', 'old\n']])),
      PATCH_ERROR_CODES.targetExists,
    )

    const update = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: missing.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ]))
    expectPatchError(
      () => planPatch(update, new Map([['missing.txt', null]])),
      PATCH_ERROR_CODES.fileNotFound,
    )
  })
})
