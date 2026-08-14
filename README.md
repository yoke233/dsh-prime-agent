# dsh-prime-agent

`dsh-prime-agent` is an RLM-first control plane for DeepSeek Harness. It turns large context and intermediate results into a persistent, addressable workspace, then lets Code Mode coordinate reads, tools, subagents, and background jobs as one program.

[简体中文](README.zh.md) · [Architecture](docs/v2-architecture.md) · [v0.3 roadmap](docs/v0.3-roadmap.md) · [Prime Agent learnings](docs/prime-agent-learnings.md) · [Upstream sync manual](docs/upstream-sync.md)

Version 0.2 is a clean redesign. It does not read 0.1 state, preserve the old `prime_harness` API, or provide a migration path. Version 0.3 adds the Persistent TypeScript Realm: an authenticated per-session realm whose `state`, functions, and module cache survive across `run_code` calls.

## Design

The plugin separates three responsibilities:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| RLM workspace | `prime_context` | Durable values, metadata catalog, bounded reads, literal search, and optimistic writes |
| Control plane | DSH Code Mode | Programmatic tool composition, `Promise.all`, subagent admission, and job collection |
| Continual learning | `prime_refine` | Small, evidence-backed, rollback-safe routing and behavior lessons |

Only workspace metadata enters the dynamic prompt. Values remain in content-addressed blobs until the model explicitly calls `get` or `search`. This keeps prompt cost tied to the current decision instead of total stored context.

Version 0.2 reuses DSH's public Agent Loop, Code Mode, Code Runtime, Subagent, Jobs, Goal, Workflow, Session, and cancellation contracts. It does not patch Harness, embed IPython, or create a second worker lifecycle.

## Install

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

`dsh plugin add` provides everything: the package's bundle patch swaps the host `code-runtime` provider for `dsh-prime-agent/runtime`, and the packaged Prime preset — a copy of the DSH Code preset plus the scoped Prime rows — is placed into `$DSH_HOME/.agent-presets` at startup when absent. Enabling Prime mode is just picking the Prime preset for a session; the default preset and every other preset keep official one-shot semantics. The placed preset is never overwritten afterwards — neither plugin nor harness upgrades refresh it; delete `$DSH_HOME/.agent-presets/prime` and restart to re-place the current snapshot.

## RLM workflow

In Code Mode, start from metadata, retrieve only the needed pieces, and persist reusable results:

```ts
const catalog = await tools.prime_context({ operation: 'catalog' })
const source = await tools.prime_context({
  operation: 'get',
  key: 'repository-map',
  offset: 0,
  limit: 12000,
})

const reviews = await Promise.all([
  tools.subagent({
    description: 'review storage',
    prompt: `Review storage boundaries:\n${source.content}`,
    run_in_background: false,
  }),
  tools.subagent({
    description: 'review orchestration',
    prompt: `Review orchestration boundaries:\n${source.content}`,
    run_in_background: false,
  }),
])

return await tools.prime_context({
  operation: 'put',
  expected_revision: catalog.revision,
  key: 'review-results',
  kind: 'json',
  summary: 'Independent storage and orchestration reviews',
  value: reviews,
})
```

For admission-first work, call a visible subagent tool with `run_in_background: true`, keep its returned job id, continue other work, and later collect it with `job_output`. The exact subagent and job parameters come from the DSH tools installed in the active profile; this plugin does not duplicate their schemas.

## `prime_context`

All operations default to `scope: "local"`. Local state belongs to the calling agent session. Global access is disabled by default.

| Operation | Required input | Result |
| --- | --- | --- |
| `catalog` | none | Paginated entries, total bytes, and current revision; never value content |
| `put` | `expected_revision`, `key`, `kind`, `summary`, `value` | Creates or replaces a value and advances the manifest revision |
| `get` | `key` | Bounded text/serialized-JSON range, JSON Pointer selection, or artifact reference |
| `search` | `query` | Bounded literal matches with before/after windows |
| `delete` | `expected_revision`, `key` | Removes the catalog entry and advances the revision |

Value kinds:

- `text`: an exact string.
- `json`: lossless JSON. Use an RFC 6901 `pointer` for structured selection.
- `artifact`: `{ uri, mediaType?, description? }`; the external subsystem remains the artifact owner.

`put` and `delete` use optimistic concurrency. Read the current revision with `catalog`, then pass it as `expected_revision`. A stale writer receives an explicit conflict instead of overwriting newer work.

## `prime_refine`

Continual learning is deliberately secondary. Do not store research, task state, tool output, or large context in it. Use it only after repeated failures, a user correction, or a stable reusable tactic.

- `inspect` returns the current revision, entries, and recent transactions.
- `apply` requires the inspected revision, a trigger, concrete evidence, a falsifiable expected outcome, and minimal create/update/delete edits.
- `rollback` requires the current revision and target transaction id, and succeeds only when affected entries have not drifted.

Entry kinds are `prompt`, `memory`, `skill`, and `subagent`. Skill and subagent entries may only reference tools that are actually visible; they document routing and do not create capability or expand authority.

## Configuration

`stateDirectory` is required. Defaults below are used when an option is omitted.

| Option | Default | Meaning |
| --- | --- | --- |
| `contextToolName` | `prime_context` | RLM workspace tool name |
| `refineToolName` | `prime_refine` | Continual-learning tool name |
| `allowGlobalContext` | `false` | Allow model access to the global workspace |
| `allowGlobalRefinement` | `false` | Allow model access to global learning state |
| `requireCodeMode` | `true` | Require `run_code` to be the sole model-visible tool |
| `requireOrchestrationTools` | `true` | Require subagent admission and `job_output` |
| `context` | bounded defaults | Workspace quotas, read/search limits, and catalog prompt budget |
| `continual` | bounded defaults | Learning entry, transaction, state, and prompt limits |

The package bundle patch carries only the host `code-runtime` swap, leaving the default preset and tool presentation untouched. The `dsh-prime-agent/runtime` row additionally accepts the official budget fields (`computeMs`, `maxWallMs`, `maxOutputBytes`, `maxOldGenerationSizeMb`, passed through verbatim) and realm-pool governance (`maxActiveRealms`, `maxIdleMs`, `maxHostCallsPerRun`, `maxParallelHostCallsPerRun`, `maxStateEntries`).

## Storage and safety

- New state is stored under `<stateDirectory>/rlm` and `<stateDirectory>/continual`; 0.1 files are never inspected.
- Local manifest filenames are SHA-256 hashes of session ids.
- RLM values are immutable SHA-256-addressed blobs; manifests contain metadata and hashes.
- Manifest commits use cross-process locks and atomic replacement. Blob hash and byte length are verified on reads.
- Catalog, value, scope, manifest, read, and search budgets are all deployment-controlled.
- Continual-learning entries are rendered as JSON-quoted, untrusted advisory records. Structural metadata rejects control and formatting characters; records never override current system, user, permission, or tool constraints.
- Malformed, oversized, missing, or conflicting state fails explicitly.
- Delete removes a manifest reference but currently retains its immutable blob. Capsule sharing and blob retention/collection are deferred to a later version.

POSIX owner-only modes are requested where the host platform honors them. This is persistence and integrity hardening, not a security sandbox.

## Why IPython is a reference, not a backend

DSH Code Mode already supplies scoped tools, logging, cancellation, Subagent, and Jobs integration, so Prime keeps one model-facing programming surface and makes data persistence explicit through `prime_context`.

This is a persistent RLM workspace, not a persistent JavaScript heap. The current public `CodeRunRequest` contains only the program, bindings, and abort signal; it carries no owning Session identity or release lifecycle, and the standard worker runtime is intentionally one-shot. The plugin therefore does not claim that functions, imports, objects, indexes, or clients survive a `run_code` call. It also does not fake that guarantee by replaying side-effectful code, monkey-patching Harness, or nesting another code executor.

The approved [v0.3 roadmap](docs/v0.3-roadmap.md) keeps the native Code Mode bridge and uses an authenticated `prime_realm_identity` binding handshake to route Prime sessions into persistent workers while ordinary sessions retain the official one-shot runtime. `prime_context` remains the reliable explicit state layer; IPython remains a design reference only.

## Development

Development tests resolve public DSH package names to the sibling `../deepseek-harness` checkout. The published package imports only public package names.

DSH peer ranges are intentionally limited to the compatible `0.1.x` line. They are optional so npm does not install a second Harness package graph into a host that already supplies them; the runtime row fails with an explicit diagnostic when the profile's bundles do not supply the Code Mode packages it imports (use a web or headless profile), and plugin loading still fails if the selected DSH composition lacks a required service. Dynamic prompt providers use bounded synchronous file snapshots because the current DSH `PromptContext` contract is synchronous; keep the state directory on local storage rather than a network filesystem.

```sh
npm run typecheck
npm test
npm run build
```
