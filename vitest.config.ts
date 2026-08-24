import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^dsh-prime-agent\/runtime$/, replacement: resolve(import.meta.dirname, 'src/runtime.ts') },
      { find: /^dsh-prime-agent$/, replacement: resolve(import.meta.dirname, 'src/index.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
