import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const ANALYZER = resolve(import.meta.dirname, '../.agents/skills/dsh-log-triage/scripts/analyze-dsh-logs.mjs')
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function nestedFailure(time: number, message: string): object {
  return {
    type: 'tool/result',
    time,
    data: {
      result: {
        isError: true,
        content: [{ type: 'text', text: message }],
      },
    },
  }
}

describe('DSH log triage analyzer', () => {
  it('classifies variable parser wording and actionable external failures', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-log-triage-'))
    const project = join(root, 'project')
    const sessionDirectory = join(root, 'sessions', 'fixture-project', 'fixture-session')
    await mkdir(sessionDirectory, { recursive: true })
    const now = Date.now()
    const events = [
      { type: 'session', cwd: project, createdAt: now },
      { type: 'request/context', time: now, data: { provider: 'fixture', model: 'fixture-model' } },
      nestedFailure(now + 1, 'Error: repl cell failed (exception): TypeScript parse failed before execution: Unexpected token ident. Expected identifier. Correct the syntax and retry the cell.'),
      nestedFailure(now + 2, "Error: repl cell failed (exception): Identifier 'value' has already been declared"),
      nestedFailure(now + 3, 'Error: repl cell failed (exception): old_string matched 2 times in "file.ts"; provide a more specific old_string or set replace_all to true'),
      nestedFailure(now + 4, 'Error: repl cell failed (exception): Exa MCP rate limit reached (429)'),
      nestedFailure(now + 5, 'Error: repl cell failed (exception): subagent "fixture-agent" is unavailable'),
      {
        type: 'turn/end',
        time: now + 6,
        data: { reason: { kind: 'error', error: { code: 'UNKNOWN_MODEL', message: 'selected route cannot serve this request' } } },
      },
    ]
    const body = events.map(event => JSON.stringify(event)).join('\n') + '\n'
    await writeFile(join(sessionDirectory, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(body)))

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      ANALYZER,
      '--project', project,
      '--since', new Date(now - 1_000).toISOString(),
      '--until', new Date(now + 10_000).toISOString(),
      '--dsh-home', root,
      '--json',
    ], { cwd: resolve(import.meta.dirname, '..'), timeout: 30_000 })

    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as {
      nestedToolErrors: number
      fatalTurnErrors: number
      categories: Record<string, number>
    }
    expect(report.nestedToolErrors).toBe(5)
    expect(report.fatalTurnErrors).toBe(1)
    expect(report.categories).toEqual({
      'generated REPL code error': 2,
      'stale or ambiguous edit': 1,
      'external provider rate limit': 1,
      'provider model configuration': 1,
      'agent lifecycle or availability': 1,
    })
  })
})
