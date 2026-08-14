import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { interpolate, isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { installPrimePreset } from '../src/realm/preset-install.js'

/** The preset directory this package publishes, exactly as it ships. */
const packaged = resolve(import.meta.dirname, '../agent-presets/prime')

let workspace: string | undefined

afterEach(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

/** A fresh stand-in for `$DSH_HOME`. */
async function harnessHome(): Promise<string> {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-prime-preset-'))
  return workspace
}

/** Every file in one directory, by name, with its content and identity. */
async function snapshot(dir: string): Promise<Record<string, { text: string; mtimeMs: number; size: number }>> {
  const entries: Record<string, { text: string; mtimeMs: number; size: number }> = {}
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name)
    const { mtimeMs, size } = await stat(path)
    entries[name] = { text: await readFile(path, 'utf8'), mtimeMs, size }
  }
  return entries
}

describe('installPrimePreset', () => {
  it('copies the packaged preset in full on first placement', async () => {
    const home = await harnessHome()
    const target = join(home, '.agent-presets', 'prime')

    expect(await installPrimePreset({ sourceDir: packaged, targetDir: target })).toBe('installed')

    const names = (await readdir(packaged)).sort()
    expect(names).toContain('agent.cordis.yml')
    expect(names).toContain('preset.yml')
    expect((await readdir(target)).sort()).toEqual(names)
    for (const name of names) {
      expect(await readFile(join(target, name), 'utf8')).toBe(await readFile(join(packaged, name), 'utf8'))
    }
  })

  it('writes nothing on a second placement', async () => {
    const home = await harnessHome()
    const target = join(home, '.agent-presets', 'prime')
    await installPrimePreset({ sourceDir: packaged, targetDir: target })
    const before = await snapshot(target)

    expect(await installPrimePreset({ sourceDir: packaged, targetDir: target })).toBe('already-present')

    // Content AND identity: an atomic rewrite with identical bytes would still
    // discard a user's edit if it raced one, so the mtimes have to hold too.
    expect(await snapshot(target)).toEqual(before)
  })

  it('never overwrites a copy the user has edited', async () => {
    const home = await harnessHome()
    const target = join(home, '.agent-presets', 'prime')
    await mkdir(target, { recursive: true })
    const edited = "- id: only-mine\n  name: '@deepseek-ai/dsh-tool-fs'\n"
    await writeFile(join(target, 'agent.cordis.yml'), edited)

    expect(await installPrimePreset({ sourceDir: packaged, targetDir: target })).toBe('already-present')

    expect(await readFile(join(target, 'agent.cordis.yml'), 'utf8')).toBe(edited)
    // Not merged either: the packaged `preset.yml` must not appear beside the
    // user's composition, which would relabel a preset they rewrote.
    expect(await readdir(target)).toEqual(['agent.cordis.yml'])
  })

  it('reports an occupied target even when the directory is empty', async () => {
    const home = await harnessHome()
    const target = join(home, '.agent-presets', 'prime')
    await mkdir(target, { recursive: true })

    expect(await installPrimePreset({ sourceDir: packaged, targetDir: target })).toBe('already-present')
    expect(await readdir(target)).toEqual([])
  })

  it('places the preset exactly once under concurrent placement and leaves no staging directory', async () => {
    const home = await harnessHome()
    const parent = join(home, '.agent-presets')
    const target = join(parent, 'prime')

    const results = await Promise.all([
      installPrimePreset({ sourceDir: packaged, targetDir: target }),
      installPrimePreset({ sourceDir: packaged, targetDir: target }),
    ])

    expect(results.filter(result => result === 'installed')).toHaveLength(1)
    expect(results.filter(result => result === 'already-present')).toHaveLength(1)
    expect((await readdir(parent)).sort()).toEqual(['prime'])
    expect((await readdir(target)).sort()).toEqual((await readdir(packaged)).sort())
  })

  it('fails loudly when the packaged preset directory is absent', async () => {
    const home = await harnessHome()
    await expect(installPrimePreset({
      sourceDir: join(home, 'not-published'),
      targetDir: join(home, '.agent-presets', 'prime'),
    })).rejects.toThrow(/packaged preset directory .* is missing or is not a directory/)
    // A failed placement claims nothing: the roster must not see an empty id.
    await expect(stat(join(home, '.agent-presets', 'prime'))).rejects.toThrow()
  })

  it('fails loudly when the packaged preset path is not a directory', async () => {
    const home = await harnessHome()
    const file = join(home, 'prime-as-a-file')
    await writeFile(file, 'not a preset directory\n')
    await expect(installPrimePreset({
      sourceDir: file,
      targetDir: join(home, '.agent-presets', 'prime'),
    })).rejects.toThrow(/is missing or is not a directory/)
  })
})

describe('packaged Prime preset composition', () => {
  it('parses in the loader entry-list dialect and carries the Prime and Code Mode rows', async () => {
    const text = await readFile(join(packaged, 'agent.cordis.yml'), 'utf8')
    // The dialect discovery itself uses: `!!js` scalars survive as expression
    // nodes rather than failing the parse.
    const rows = load(text, { schema: entryListSchema }) as Record<string, any>[]

    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(typeof row).toBe('object')
      expect(Array.isArray(row)).toBe(false)
      expect(typeof row.name).toBe('string')
      expect(row.name).not.toBe('')
    }

    const prime = rows.find(row => row.id === 'prime-agent')
    expect(prime?.name).toBe('dsh-prime-agent')

    // The preset must still present itself as Code Mode: the plugin's
    // `requireCodeMode` invariant fails assembly for any other presentation.
    const presentation = rows.find(row => row.id === 'tool-presentation')
    expect(presentation?.name).toBe('@deepseek-ai/dsh-agent-tool-presentation')
    expect(presentation?.config?.mode).toBe('code')
  })

  it('derives stateDirectory from a `!!js` harness-home expression', async () => {
    const text = await readFile(join(packaged, 'agent.cordis.yml'), 'utf8')
    const rows = load(text, { schema: entryListSchema }) as Record<string, any>[]
    const prime = rows.find(row => row.id === 'prime-agent')

    // A literal path here would be wrong in every deployment but the author's,
    // and could not match the runtime row's `stateDirectory` in cordis.patch.yml.
    expect(isJsExpr(prime?.config?.stateDirectory)).toBe(true)

    // Evaluated the way the Loader evaluates an entry's config: `dshHomePath`
    // is resolved from the context the row's fiber chains to.
    const resolved = interpolate(
      { dshHomePath: (...segments: string[]) => join('/dsh-home', ...segments) },
      prime?.config,
    ) as { stateDirectory: string }
    expect(resolved.stateDirectory).toBe(join('/dsh-home', 'prime-agent'))
  })

  it('publishes display metadata that sorts after the shipped presets', async () => {
    const metadata = load(await readFile(join(packaged, 'preset.yml'), 'utf8')) as Record<string, unknown>
    expect(metadata.name).toBe('Prime 模式')
    expect(typeof metadata.description).toBe('string')
    // The shipped roster occupies 1..4; a duplicate order would leave the
    // picker ordering Prime against a shipped preset by id.
    expect(metadata.order).toBe(5)
  })
})
