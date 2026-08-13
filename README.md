# dsh-prime-agent

`dsh-prime-agent` is an RLM-first control plane for DeepSeek Harness. It turns large context and intermediate results into a persistent, addressable workspace, then lets Code Mode coordinate reads, tools, subagents, and background jobs as one program.

[简体中文](README.zh.md) · [Architecture](docs/v2-architecture.md) · [v0.3 roadmap](docs/v0.3-roadmap.md) · [Prime Agent learnings](docs/prime-agent-learnings.md) · [Upstream sync manual](docs/upstream-sync.md)

Version 0.2 is a clean redesign. It does not read 0.1 state, preserve the old `prime_harness` API, or provide a migration path.

## Design

The plugin separates three responsibilities:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| RLM workspace | `prime_context` | Durable values, metadata catalog, bounded reads, literal search, and optimistic writes |
| Control plane | DSH Code Mode | Programmatic tool composition, `Promise.all`, subagent admission, and job collection |
| Continual learning | `prime_refine` | Small, evidence-backed, rollback-safe routing and behavior lessons |

Only workspace metadata enters the dynamic prompt. Values remain in content-addressed blobs until the model explicitly calls `get` or `search`. This keeps prompt cost tied to the current decision instead of total stored context.

Version 0.2 reuses DSH's Agent Loop, TypeScript Code Runtime, Subagent, Jobs, Goal, Workflow, Session, and cancellation semantics. It does not embed IPython or create a second worker lifecycle.

## Install

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

The included bundle patch selects Code Mode and stores fresh state below `$DSH_HOME/prime-agent-v2`. Use another profile name, such as `headless`, when appropriate.

The default bundle requires visible `subagent` (or `subagent_fork`) and `job_output` tools. Assembly fails loudly when the selected DSH preset does not compose them.

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

`stateDirectory` is required. Defaults below are the values used by the bundled preset.

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

See [cordis.patch.yml](cordis.patch.yml) for every concrete limit.

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

Version 0.2 prioritized a programmable control plane over addressable data and asynchronous agents. DSH's TypeScript Code Runtime already supplied scoped tools, logging, cancellation, Subagent, and Jobs integration, so `prime_context` delivered reliable data persistence first.

This already captures much of Prime Agent's working feel: DSH PTC/Code Mode gives the model one programmable surface for composing tools and recursive agents, while `prime_context` keeps large data outside the model context. It is not yet equivalent to Prime's persistent computational state, because each v0.2 `run_code` invocation loses functions, imports, objects, indexes, and clients when its JavaScript worker exits.

The remaining invariant is a persistent computational namespace, not Python syntax. The [v0.3 roadmap](docs/v0.3-roadmap.md) therefore extends the existing PTC path with a session-scoped Persistent TypeScript Realm instead of adding another model-facing runtime. `prime_context` remains the reliable explicit data layer. IPython is retained only as a reference for cell continuity, interruption, and honest recovery semantics; it is not a planned product backend.

## Development

Development tests resolve public DSH package names to the sibling `../deepseek-harness` checkout. The published package imports only public package names.

DSH peer ranges are intentionally limited to the compatible `0.1.x` line. They are optional so npm does not install a second Harness package graph into a host that already supplies them; plugin loading still fails if the selected DSH composition lacks a required service. Dynamic prompt providers use bounded synchronous file snapshots because the current DSH `PromptContext` contract is synchronous; keep the state directory on local storage rather than a network filesystem.

```sh
npm run typecheck
npm test
npm run build
```
