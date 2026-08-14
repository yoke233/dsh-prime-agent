# Prime Agent E2E Execution Plan

## Objective

Prove the Prime persistent realm through the same seams production uses, starting at the deterministic `run_code` transport and extending through host patch composition, agent-preset mounting, and an optional real-model smoke test.

## Execution status

- [x] Phase 1 — real `run_code` transport (`tests/prime-run-code.e2e.spec.ts`, focused and full-suite verification passing)
- [x] Phase 2A — host patch composition (`tests/prime-compose.e2e.spec.ts`, focused test passing)
- [x] Phase 2B — packaged Prime realm rows mounted through the real AgentPresets seam (`tests/prime-preset-mount.e2e.spec.ts`)
- [x] Phase 3A — deterministic two-turn agent-loop via public testkit and LLM replay (`tests/prime-agent-loop.e2e.spec.ts`)
- [x] Phase 3B — optional real-model smoke (`tests/prime-model.e2e.spec.ts`; credential-gated and verified skipped without a key)

## Working rules

- Preserve all pre-existing working-tree changes. Limit edits to files named by the active phase and required dependency/config updates.
- Test behavior through public seams. Assert equal agent IDs share state and different IDs are isolated; do not assert that an agent ID is the runtime pool key.
- Distinguish model presentation from program capability. Code Mode exposes only `run_code` on the wire, may document `prime_realm_identity` in the generated SDK, and removes that binding from the executed program after the runtime bootstrap.
- Keep deterministic coverage in the default CI suite. Gate network/provider coverage on credentials.
- Dispose every Context and remove every temporary directory in `afterEach`, including failure paths.

## Phase 1 — Real `run_code` transport

Create `tests/prime-run-code.e2e.spec.ts` using the Harness Code Mode fixture pattern.

### Fixture

1. Create a temporary Prime state directory.
2. Mount `SystemPrompt`.
3. Mount `ToolRuntime` with `{ mode: 'code' }`.
4. Mount `dsh-prime-agent/runtime` against the temporary state directory.
5. Register the real realm identity tool against that same directory.
6. Build structural test agents with a branded `SessionId`, `session.header.cwd`, and a recording `session.append`.
7. Execute `RUN_CODE_NAME` through `ctx.tools.execute({ callId, name, arguments, signal, agent })` and unwrap the canonical `{ logs, result? }` value only after checking `isError`.

### Assertions

- The first run stores a `Map` and a closure in `state`, returns `1`, and reports a fresh generation.
- A second run with the same agent reads through the stored closure, returns `{ id: 'a' }`, and reports generation 1 retained.
- A run with a different agent ID observes empty state.
- The executed program sees `prime_realm_identity` as absent from membership, keys, and property access.
- System-prompt assembly for the agent exposes exactly `[run_code]` as wire tools. This assertion does not require the identity tool to be absent from generated SDK text.

### Completion criterion

The new test passes alone and with the existing Prime runtime suite, and TypeScript accepts the fixture without broad casts beyond the structural test Agent.

## Phase 2A — Host patch composition

Create `tests/prime-compose.e2e.spec.ts` to exercise `boot()` with a minimal host configuration containing an official `id: code-runtime` row.

### Setup

1. Add `@deepseek-ai/dsh-app-boot` as an explicit dev dependency or add the repository-standard Vitest source alias if package policy requires sibling-source testing.
2. Parse `cordis.patch.yml` into `PatchOptions[]`; pass those objects to `boot()`, not the filename.
3. Set `DSH_HOME` to a temporary directory and restore it after the test.
4. Supply a `bareModuleBaseUrl` that resolves `dsh-prime-agent/runtime` from this package when the root config is temporary.

### Assertions

- The official row is disabled and the Prime runtime row activates without a duplicate `codeRuntime` provider.
- Real `run_code` calls preserve state for one agent and isolate a second agent.
- The packaged Prime preset appears under `$DSH_HOME/.agent-presets/prime`; compare its required files with the packaged source because placement failure is warning-only.

### Completion criterion

The test proves Loader patch application and startup wiring behavior; it does not claim that copying a preset mounted it for an agent.

## Phase 2B — Prime preset mounting

Add a deterministic agent-scoped composition test that extracts the exact shipped realm and presentation rows from `agent-presets/prime/agent.cordis.yml`, excluding unrelated tool integrations from this seam.

### Assertions

- The preset mounts inside one agent scope.
- Its effective model presentation exposes only `run_code` on the wire.
- The real identity tool is automatically supplied to the Prime runtime.
- Two transport executions for that agent retain state without manually registering or constructing a handshake binding in the test.

### Completion criterion

Together with Phase 2A, the tests cross both host and agent composition seams. File placement alone is insufficient; the mounted preset must be responsible for the identity binding.

## Phase 3A — Deterministic agent-loop

If the repository can reuse the Harness mock LLM adapter without importing test-private implementation, add a two-turn agent-loop test whose scripted responses issue one `run_code` call per turn.

Assert request headers offer only `run_code`, both outer tool calls name `run_code`, and the second turn returns state written by the first. Prefer `agent.whenIdle()` or the established status-listener helper.

### Completion criterion

The two-turn result is deterministic, keyless, and runs in default CI. If the mock adapter would create a shallow local copy of Harness internals, record that finding and omit this phase.

## Phase 3B — Optional real-model smoke

Mirror the Harness headless Code Mode E2E behind `describe.skipIf(!process.env.DEEPSEEK_API_KEY)`.

Use one stable session across two prompts. Assert every request header offers only `run_code`, every outer tool call names `run_code`, and the final assistant message contains the sentinel persisted during the first turn. Treat this as provider integration coverage, not a correctness gate for the runtime.

### Completion criterion

The test is skipped without credentials and passes against the configured DeepSeek route when credentials are available.

## Verification gates

Run after each phase:

1. The new test file alone.
2. `tests/prime-runtime.spec.ts`, `tests/packaging-boundary.spec.ts`, and `tests/preset-install.spec.ts` with the new test.
3. `npm run typecheck`.
4. At the final phase, `npm test` and `npm run build`.

Record sandbox-only process-spawn failures separately from test failures; rerun the exact command with approved process access rather than changing the test command.

## Final verification

- `npm run check` passed: typecheck, clean build, and the complete Vitest suite.
- Vitest result: 15 files and 127 tests passed; the credential-gated real-model smoke was the sole skipped file/test.
- `git diff --check` passed.
- `DEEPSEEK_API_KEY` was not present, so the network smoke was verified as correctly skipped rather than executed against the provider.
