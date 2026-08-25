import { defineConfig } from 'vitest/config'
import { modelTests, resolveConfig } from './vitest.suites.js'

process.env.DSH_RUN_MODEL_E2E = '1'

export default defineConfig({
  resolve: resolveConfig,
  test: { include: modelTests },
})
