const UNICODE_EQUIVALENTS = new Map<string, string>([
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'], ['—', '-'], ['―', '-'], ['−', '-'],
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], ['　', ' '],
])

/** Locate a Codex patch sequence using progressively more permissive matching. */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | null {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return null

  const searchStart = endOfFile ? lines.length - pattern.length : start
  const lastStart = lines.length - pattern.length
  const comparators: ReadonlyArray<(value: string) => string> = [
    value => value,
    value => value.trimEnd(),
    value => value.trim(),
    normalizeUnicode,
  ]

  for (const normalize of comparators) {
    for (let index = searchStart; index <= lastStart; index += 1) {
      if (pattern.every((line, offset) => normalize(lines[index + offset] ?? '') === normalize(line))) {
        return index
      }
    }
  }
  return null
}

function normalizeUnicode(value: string): string {
  return [...value.trim()].map(character => UNICODE_EQUIVALENTS.get(character) ?? character).join('')
}
