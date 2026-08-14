import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const dsh = resolve(import.meta.dirname, '../deepseek-harness')

export default defineConfig({
  resolve: {
    alias: [
      { find: /^dsh-prime-agent\/runtime$/, replacement: resolve(import.meta.dirname, 'src/runtime.ts') },
      { find: /^dsh-prime-agent\/subagent-report$/, replacement: resolve(import.meta.dirname, 'src/subagent/report.ts') },
      { find: /^dsh-prime-agent$/, replacement: resolve(import.meta.dirname, 'src/index.ts') },
      ...[
        ['@deepseek-ai/cordis', 'vendor/cordis/src/index.ts'],
        ['@deepseek-ai/cordis-plugin-include', 'vendor/include/src/index.ts'],
        ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader/src/index.ts'],
        ['@deepseek-ai/dsh-app-boot', 'packages/boot/app-boot/src/index.ts'],
        ['@deepseek-ai/dsh-cmdline', 'packages/boot/cmdline/src/index.ts'],
        ['@deepseek-ai/dsh-agent-presets', 'packages/preset/agent-presets/src/index.ts'],
        ['@deepseek-ai/dsh-agent-tool-presentation', 'packages/core/agent-tool-presentation/src/index.ts'],
        ['@deepseek-ai/schemastery', 'vendor/schemastery/src/index.ts'],
        ['@deepseek-ai/dsh-agent', 'packages/core/agent/src/index.ts'],
        ['@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop/src/index.ts'],
        ['@deepseek-ai/dsh-agent-loop-testkit', 'packages/test-support/agent-loop-testkit/src/index.ts'],
        ['@deepseek-ai/dsh-atomic-write', 'packages/util/atomic-write/src/index.ts'],
        ['@deepseek-ai/dsh-llm', 'packages/llm/llm/src/index.ts'],
        ['@deepseek-ai/dsh-llm-deepseek', 'packages/llm/llm-deepseek/src/index.ts'],
        ['@deepseek-ai/dsh-llm-replay', 'packages/test-support/llm-replay/src/index.ts'],
        ['@deepseek-ai/dsh-scope', 'packages/core/scope/src/index.ts'],
        ['@deepseek-ai/dsh-session', 'packages/core/session/src/index.ts'],
        ['@deepseek-ai/dsh-session-persistence', 'packages/session/session-persistence/src/index.ts'],
        ['@deepseek-ai/dsh-settings', 'packages/settings/settings/src/index.ts'],
        ['@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt/src/index.ts'],
        ['@deepseek-ai/dsh-tools', 'packages/core/tools/src/index.ts'],
        ['@deepseek-ai/dsh-user-approval', 'packages/interaction/user-approval/src/index.ts'],
        ['@deepseek-ai/dsh-code-runtime', 'packages/code-runtime/code-runtime/src/index.ts'],
        ['@deepseek-ai/dsh-code-runtime-worker-thread', 'packages/code-runtime/code-runtime-worker-thread/src/index.ts'],
        ['@deepseek-ai/dsh-timeout', 'packages/util/timeout/src/index.ts'],
        ['@deepseek-ai/dsh-invariants', 'packages/runtime-diagnostics/invariants/src/index.ts'],
        ['@deepseek-ai/dsh-brand', 'packages/util/brand/src/index.ts'],
        ['@deepseek-ai/dsh-typert-protocol', 'packages/typert/protocol/src/index.ts'],
        ['@deepseek-ai/dsh-subagent', 'packages/subagent/subagent/src/index.ts'],
        ['@deepseek-ai/dsh-jobs', 'packages/jobs/jobs/src/index.ts'],
        ['@deepseek-ai/dsh-jobs-local', 'packages/jobs/jobs-local/src/index.ts'],
        ['@deepseek-ai/dsh-tool-jobs', 'packages/jobs/tool-jobs/src/index.ts'],
        ['@deepseek-ai/dsh-tool-subagent', 'packages/subagent/tool-subagent/src/index.ts'],
        ['@deepseek-ai/dsh-output-retention', 'packages/util/output-retention/src/index.ts'],
        ['@deepseek-ai/dsh-spill', 'packages/spill/spill/src/index.ts'],
        ['@deepseek-ai/dsh-spill-local', 'packages/spill/spill-local/src/index.ts'],
        ['@deepseek-ai/dsh-spill-policy', 'packages/spill/spill-policy/src/index.ts'],
        ['@deepseek-ai/dsh-fs', 'packages/fs/fs/src/index.ts'],
        ['@deepseek-ai/dsh-fs-local', 'packages/fs/fs-local/src/index.ts'],
        ['@deepseek-ai/dsh-fs-sandbox', 'packages/fs/fs-sandbox/src/index.ts'],
        ['@deepseek-ai/dsh-tool-fs', 'packages/fs/tool-fs/src/index.ts'],
        ['@deepseek-ai/dsh-sandbox', 'packages/sandbox/sandbox/src/index.ts'],
        ['@deepseek-ai/dsh-sandbox-policy', 'packages/sandbox/sandbox-policy/src/index.ts'],
      ].map(([name, path]) => ({ find: new RegExp(`^${name}$`), replacement: resolve(dsh, path) })),
    ]
  },
  test: {
    include: ['tests/**/*.spec.ts']
  }
})
