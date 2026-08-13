import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(projectRoot, 'lib')

if (dirname(outputDirectory) !== projectRoot) {
  throw new Error(`refusing to clean unexpected output directory: ${outputDirectory}`)
}

await rm(outputDirectory, { recursive: true, force: true })
