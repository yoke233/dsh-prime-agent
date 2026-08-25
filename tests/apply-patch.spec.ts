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

  it('accepts CRLF patch syntax and normalizes updated content to LF', () => {
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
        content: 'before\nnew\nafter\n',
        hunks: 1,
      }],
    })
  })

  it('normalizes an updated non-empty file to a trailing newline', () => {
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
      .toBe('first\nchanged\n')
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

  it('rejects missing context and uses the first matching occurrence', () => {
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
    expect(planPatch(ambiguous, new Map([['sample.txt', 'same\nmiddle\nsame\n']])).files[0]?.content)
      .toBe('changed\nmiddle\nsame\n')
  })

  it.each([
    ['trailing whitespace', 'alpha   \nbeta\t\n', 'alpha\nbeta', 'new\n'],
    ['surrounding whitespace', '  alpha  \n\tbeta\t\n', 'alpha\nbeta', 'new\n'],
    ['Unicode punctuation', '“alpha”—beta value\n', '"alpha"-beta value', 'new\n'],
  ])('matches Codex-style fuzzy context with %s', (_name, source, oldText, expected) => {
    const oldLines = oldText.split('\n').map(line => `-${line}`)
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: fuzzy.txt',
      '@@',
      ...oldLines,
      '+new',
      '*** End Patch',
    ]))
    expect(planPatch(parsed, new Map([['fuzzy.txt', source]])).files[0]?.content).toBe(expected)
  })

  it('places pure additions at end of file like Codex', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: append.txt',
      '@@ first',
      '+third',
      '*** End Patch',
    ]))
    expect(planPatch(parsed, new Map([['append.txt', 'first\nsecond\n']])).files[0]?.content)
      .toBe('first\nsecond\nthird\n')
  })

  it('keeps multiple pure additions in patch order', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: append.txt',
      '@@',
      '+second',
      '@@',
      '+third',
      '*** End Patch',
    ]))
    expect(planPatch(parsed, new Map([['append.txt', 'first\n']])).files[0]?.content)
      .toBe('first\nsecond\nthird\n')
  })

  it('prefers a later exact match over an earlier fuzzy match', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: precedence.txt',
      '@@',
      '-value',
      '+changed',
      '*** End Patch',
    ]))
    expect(planPatch(parsed, new Map([['precedence.txt', ' value \nvalue\n']])).files[0]?.content)
      .toBe(' value \nchanged\n')
  })

  it('accepts Codex marker whitespace, heredoc wrapping, and environment id', () => {
    const parsed = parsePatch([
      "<<'EOF'",
      '  *** Begin Patch  ',
      '*** Environment ID: env-1',
      '  *** Update File: wrapped.txt  ',
      '@@',
      '-old',
      '+new',
      '  *** End Patch  ',
      'EOF',
    ].join('\n'))
    expect(planPatch(parsed, new Map([['wrapped.txt', 'old\n']])).files[0]?.content).toBe('new\n')
  })

  it('keeps hunk context that looks like a file header', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: literal.txt',
      '@@',
      ' *** Update File: literal',
      '-old',
      '+new',
      '*** End Patch',
    ]))

    expect(planPatch(parsed, new Map([['literal.txt', '*** Update File: literal\nold\n']])).files[0]?.content)
      .toBe('*** Update File: literal\nnew\n')
  })

  it('rejects a heredoc closing line that only ends with EOF', () => {
    expectPatchError(
      () => parsePatch([
        '<<EOF',
        '*** Begin Patch',
        '*** Add File: invalid.txt',
        '+content',
        '*** End Patch',
        'NOTEOF',
      ].join('\n')),
      PATCH_ERROR_CODES.invalidPatch,
    )
  })

  it('parses empty patches and empty Add sections like Codex', () => {
    const emptyPatch = parsePatch(patch(['*** Begin Patch', '*** End Patch']))
    expectPatchError(() => planPatch(emptyPatch, new Map()), PATCH_ERROR_CODES.invalidPatch)

    const emptyAdd = parsePatch(patch([
      '*** Begin Patch',
      '*** Add File: empty.txt',
      '*** End Patch',
    ]))
    expect(planPatch(emptyAdd, new Map([['empty.txt', null]])).files[0]?.content).toBe('')
  })

  it('searches hunks forward and reports a missing match when they move backwards', () => {
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
      PATCH_ERROR_CODES.contextNotFound,
    )
  })

  it('treats a bare empty update line as empty context', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Update File: blank.txt',
      '@@',
      '',
      '-old',
      '+new',
      '*** End Patch',
    ]))
    expect(planPatch(parsed, new Map([['blank.txt', '\nold\n']])).files[0]?.content).toBe('\nnew\n')
  })

  it.each([
    ['', PATCH_ERROR_CODES.invalidHunk],
    ['nul\0byte.txt', PATCH_ERROR_CODES.invalidPath],
  ] as const)('rejects structurally invalid path %j', (invalidPath, errorCode) => {
    expectPatchError(
      () => parsePatch(patch([
        '*** Begin Patch',
        `*** Add File: ${invalidPath}`,
        '+content',
        '*** End Patch',
      ])),
      errorCode,
    )
  })

  it.each([
    '/absolute.txt',
    'C:\\absolute.txt',
    '../outside.txt',
    'dir/../sibling.txt',
    '\\\\server\\share.txt',
  ])('preserves path %j for the owning filesystem tools', filePath => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      `*** Add File: ${filePath}`,
      '+content',
      '*** End Patch',
    ]))

    expect(parsed.files[0]?.path).toBe(filePath)
  })

  it('plans repeated paths sequentially', () => {
    const parsed = parsePatch(patch([
      '*** Begin Patch',
      '*** Add File: src/same.txt',
      '+first',
      '*** Update File: src/same.txt',
      '@@',
      '-first',
      '+second',
      '*** End Patch',
    ]))
    expect(planPatch(parsed, new Map([['src/same.txt', null]])).files).toEqual([
      { path: 'src/same.txt', operation: 'add', content: 'first\n', hunks: 1 },
      { path: 'src/same.txt', operation: 'update', content: 'second\n', hunks: 1 },
    ])
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
      '@@',
      '-content',
      '+updated',
      '*** End Patch',
    ]))

    expect(parsed.files).toEqual([{
      operation: 'update',
      path: 'before.txt',
      movePath: 'after.txt',
      hunks: [{ context: null, oldLines: ['content'], newLines: ['updated'], endOfFile: false }],
    }])
    expectPatchError(
      () => planPatch(parsed, new Map([['before.txt', 'content\n']])),
      PATCH_ERROR_CODES.unsupportedOperation,
    )
  })

  it('allows Add to overwrite while Update still requires an existing target', () => {
    const add = parsePatch(patch([
      '*** Begin Patch',
      '*** Add File: exists.txt',
      '+new',
      '*** End Patch',
    ]))
    expect(planPatch(add, new Map([['exists.txt', 'old\n']])).files[0]?.content).toBe('new\n')

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
