import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const SCRIPT = resolve(import.meta.dirname, '../scripts/dump-prime-prompt.mjs')
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Prime prompt dump script', () => {
  it('boots the shipped composition and writes a bounded terminal result', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-prompt-script-'))
    const skillDirectory = join(root, '.agents/skills/dump-test')
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: dump-test',
      'description: Verify project skill discovery in the captured model request.',
      '---',
      '',
      '# Dump test',
      '',
    ].join('\n'))
    const output = join(root, 'prompt.txt')
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, '--cwd', root, '--output', output], {
      cwd: resolve(import.meta.dirname, '..'),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    })

    expect(stderr).toBe('')
    expect(stdout.trim()).toBe(output)
    const dump = await readFile(output, 'utf8')
    expect(dump.split('\n', 1)[0]).toMatch(/^Prompt context usage \(estimated\): [\d,]+ tokens \([\d,]+ characters\)$/)
    expect(dump).toContain('# Prime Model Request Dump')
    expect(dump).toContain('## Route')
    expect(dump).toContain('## System Prompt')
    expect(dump).toContain('## Persistent TypeScript REPL')
    expect(dump).toContain(root)
    expect(dump).toContain('## Messages')
    expect(dump).toContain('### 1. user / user')
    expect(dump).toContain('user / plugin')
    expect(dump).toContain('Current runtime context.')
    expect(dump).toContain('user / skill-catalog')
    expect(dump).toContain('<available_skills>')
    expect(dump).toContain('dump-test')
    expect(dump).toContain('refine')
    expect(dump).toContain('## Model-visible Tools')
    expect(dump).toContain('### repl')
    expect(dump).toContain('TypeScript source code for this cell.')
    expect(dump).not.toContain('str_replace_editor')
    expect(dump).not.toContain('  workflow: {')
    expect(dump).not.toContain('  refine: {')
    expect(dump).not.toContain('expected_revision')
    expect(dump).not.toContain('\"format\":')
  }, 90_000)

  it('keeps system-only output limited to the captured request system field', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-prompt-system-only-'))
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, '--cwd', root, '--system-only', '--stdout'], {
      cwd: resolve(import.meta.dirname, '..'),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    })

    expect(stderr).toBe('')
    expect(stdout.split('\n', 1)[0]).toMatch(/^Prompt context usage \(estimated\): [\d,]+ tokens \([\d,]+ characters\)$/)
    expect(stdout).toContain('## Persistent TypeScript REPL')
    expect(stdout).not.toContain('# Prime Model Request Dump')
    expect(stdout).not.toContain('## Messages')
  }, 90_000)
})
