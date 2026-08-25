import { resolve } from 'node:path'

export const resolveConfig = {
  alias: [
    { find: /^dsh-prime-agent\/runtime$/, replacement: resolve(import.meta.dirname, 'src/runtime.ts') },
    { find: /^dsh-prime-agent$/, replacement: resolve(import.meta.dirname, 'src/index.ts') },
  ],
}

/** Tests that exercise real Realm workers, composed DSH services, or processes. */
export const integrationTests = [
  'tests/**/*.e2e.spec.ts',
  'tests/**/*integration.spec.ts',
  'tests/completion-*.spec.ts',
  'tests/continuable-orchestration.spec.ts',
  'tests/loader-composition.spec.ts',
  'tests/prime-runtime.spec.ts',
  'tests/realm-identity.spec.ts',
  'tests/realm-lease.spec.ts',
  'tests/realm-worker.spec.ts',
]

export const modelTests = ['tests/prime-model.e2e.spec.ts']
