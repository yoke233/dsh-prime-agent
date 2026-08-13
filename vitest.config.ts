import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const dsh = resolve(import.meta.dirname, '../deepseek-harness')

export default defineConfig({
  resolve: {
    alias: [
      ['@deepseek-ai/cordis', 'vendor/cordis/src/index.ts'],
      ['@deepseek-ai/cordis-plugin-include', 'vendor/include/src/index.ts'],
      ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader/src/index.ts'],
      ['@deepseek-ai/schemastery', 'vendor/schemastery/src/index.ts'],
      ['@deepseek-ai/dsh-agent', 'packages/core/agent/src/index.ts'],
      ['@deepseek-ai/dsh-atomic-write', 'packages/util/atomic-write/src/index.ts'],
      ['@deepseek-ai/dsh-llm', 'packages/llm/llm/src/index.ts'],
      ['@deepseek-ai/dsh-scope', 'packages/core/scope/src/index.ts'],
      ['@deepseek-ai/dsh-session', 'packages/core/session/src/index.ts'],
      ['@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt/src/index.ts'],
      ['@deepseek-ai/dsh-tools', 'packages/core/tools/src/index.ts'],
      ['@deepseek-ai/dsh-user-approval', 'packages/interaction/user-approval/src/index.ts'],
      ['@deepseek-ai/dsh-code-runtime', 'packages/code-runtime/code-runtime/src/index.ts'],
      ['@deepseek-ai/dsh-invariants', 'packages/runtime-diagnostics/invariants/src/index.ts'],
      ['@deepseek-ai/dsh-brand', 'packages/util/brand/src/index.ts'],
      ['@deepseek-ai/dsh-typert-protocol', 'packages/typert/protocol/src/index.ts'],
      ['@deepseek-ai/dsh-subagent', 'packages/subagent/subagent/src/index.ts'],
      ['@deepseek-ai/dsh-jobs', 'packages/jobs/jobs/src/index.ts'],
      ['@deepseek-ai/dsh-jobs-local', 'packages/jobs/jobs-local/src/index.ts'],
      ['@deepseek-ai/dsh-tool-jobs', 'packages/jobs/tool-jobs/src/index.ts'],
      ['@deepseek-ai/dsh-tool-subagent', 'packages/subagent/tool-subagent/src/index.ts'],
      ['@deepseek-ai/dsh-output-retention', 'packages/util/output-retention/src/index.ts'],
    ].map(([name, path]) => ({ find: new RegExp(`^${name}$`), replacement: resolve(dsh, path) }))
  },
  test: {
    include: ['tests/**/*.spec.ts']
  }
})
