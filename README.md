# dsh-prime-agent

`dsh-prime-agent` is an RLM-first control plane for DeepSeek Harness. It gives each Prime session a persistent TypeScript realm — `state`, functions, and module cache that survive across `run_code` calls — and lets Code Mode coordinate reads, tools, subagents, and background jobs as one program.

[简体中文](README.zh.md) · [Architecture](docs/v2-architecture.md) · [v0.3 roadmap](docs/v0.3-roadmap.md) · [Prime Agent learnings](docs/prime-agent-learnings.md) · [Upstream sync manual](docs/upstream-sync.md)

Version 0.2 was a clean redesign; version 0.3 added the Persistent TypeScript Realm. Working values live in the realm namespace, and durable checkpoints go to ordinary task files.

## Design

The plugin separates three responsibilities:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Persistent realm | `dsh-prime-agent/runtime` | Per-session authenticated realm whose `state`, functions, and module cache survive across `run_code` calls |
| Control plane | DSH Code Mode | Programmatic tool composition, `Promise.all`, subagent admission, and job collection |
| Continual learning | `prime_refine` | Small, evidence-backed, rollback-safe routing and behavior lessons |

The realm is live-only by design: the control-plane policy directs the model to reduce large tool results inside the program, keep working values in `state`, and checkpoint anything that must survive a restart to durable task files at phase boundaries.

The plugin reuses DSH's public Agent Loop, Code Mode, Code Runtime, Subagent, Jobs, Goal, Workflow, Session, and cancellation contracts. It does not patch Harness, embed IPython, or create a second worker lifecycle.

## Install

```sh
npm install
npm run check
dsh plugin --profile web add ./dsh-prime-agent
```

`dsh plugin add` provides everything: the package's bundle patch swaps the host `code-runtime` provider for `dsh-prime-agent/runtime`, and the packaged Prime preset — a copy of the DSH Code preset plus the scoped Prime rows — is placed into `$DSH_HOME/.agent-presets` at startup when absent. Enabling Prime mode is just picking the Prime preset for a session; the default preset and every other preset keep official one-shot semantics. The placed preset is never overwritten afterwards — neither plugin nor harness upgrades refresh it; delete `$DSH_HOME/.agent-presets/prime` and restart to re-place the current snapshot.

## RLM workflow

In Code Mode, assign intermediate results to realm `state`, reduce large outputs inside the program, and return only what the current decision needs:

```ts
state.source ??= await tools.read({ path: 'docs/architecture.md' })

const reviews = await Promise.all([
  tools.subagent({
    description: 'review storage',
    prompt: `Review storage boundaries:\n${state.source.text}`,
    run_in_background: false,
  }),
  tools.subagent({
    description: 'review orchestration',
    prompt: `Review orchestration boundaries:\n${state.source.text}`,
    run_in_background: false,
  }),
])

state.reviews = reviews
return reviews.map(review => review.summary)
```

For admission-first work, call a visible subagent tool with `run_in_background: true`, keep its returned job id, continue other work, and later collect it with `job_output`. The exact subagent and job parameters come from the DSH tools installed in the active profile; this plugin does not duplicate their schemas.

Realm `state` survives `run_code` calls but not a worker restart: after a generation-loss notice the policy directs the model to rebuild from durable checkpoints and the task's own files.

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
| `refineToolName` | `prime_refine` | Continual-learning tool name |
| `allowGlobalRefinement` | `false` | Allow model access to global learning state |
| `requireCodeMode` | `true` | Require `run_code` to be the sole model-visible tool |
| `requireOrchestrationTools` | `true` | Require subagent admission and `job_output` |
| `continual` | bounded defaults | Learning entry, transaction, state, and prompt limits |

The package bundle patch carries only the host `code-runtime` swap, leaving the default preset and tool presentation untouched. The `dsh-prime-agent/runtime` row additionally accepts the official budget fields (`computeMs`, `maxWallMs`, `maxOutputBytes`, `maxOldGenerationSizeMb`, passed through verbatim) and realm-pool governance (`maxActiveRealms`, `maxIdleMs`, `maxHostCallsPerRun`, `maxParallelHostCallsPerRun`, `maxStateEntries`).

## Storage and safety

- Plugin state lives under `<stateDirectory>/continual` (learning layer) and `<stateDirectory>/realm-identity` (realm handshake keys); 0.1 files are never inspected.
- Local state filenames are SHA-256 hashes of session ids.
- State commits use cross-process locks and atomic replacement.
- Continual-learning entries are rendered as JSON-quoted, untrusted advisory records. Structural metadata rejects control and formatting characters; records never override current system, user, permission, or tool constraints.
- Malformed, oversized, missing, or conflicting state fails explicitly.

POSIX owner-only modes are requested where the host platform honors them. This is persistence and integrity hardening, not a security sandbox.

## Why IPython is a reference, not a backend

DSH Code Mode already supplies scoped tools, logging, cancellation, Subagent, and Jobs integration, so Prime keeps one model-facing programming surface.

The persistent realm is the DSH-native answer to Prime's persistent IPython namespace: an authenticated `prime_realm_identity` binding handshake routes Prime sessions into persistent workers while ordinary sessions retain the official one-shot runtime. See the [v0.3 roadmap](docs/v0.3-roadmap.md) for the full contract. IPython remains a design reference only.

## Development

Development tests resolve public DSH package names to the sibling `../deepseek-harness` checkout. The published package imports only public package names.

DSH peer ranges are intentionally limited to the compatible `0.1.x` line. They are optional so npm does not install a second Harness package graph into a host that already supplies them; the runtime row fails with an explicit diagnostic when the profile's bundles do not supply the Code Mode packages it imports (use a web or headless profile), and plugin loading still fails if the selected DSH composition lacks a required service. Dynamic prompt providers use bounded synchronous file snapshots because the current DSH `PromptContext` contract is synchronous; keep the state directory on local storage rather than a network filesystem.

```sh
npm run typecheck
npm test
npm run build
```
