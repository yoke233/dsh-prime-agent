import { defineConfig } from 'vitest/config'
import { integrationTests, modelTests, resolveConfig } from './vitest.suites.js'

process.env.DSH_RUN_INTEGRATION = '1'

export default defineConfig({
  resolve: resolveConfig,
  test: {
    include: integrationTests,
    exclude: modelTests,
  },
})
