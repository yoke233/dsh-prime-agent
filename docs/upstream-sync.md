# Prime Agent upstream synchronization manual

[简体中文](upstream-sync.zh.md)

This manual keeps `dsh-prime-agent` aligned with Prime Agent's design without turning the adapter into a source-code fork. The machine-readable baseline is [upstream-baseline.json](upstream-baseline.json).

## Baseline rule

The current reviewed Prime Agent baseline is:

```text
aacf04b4678fd02cf46b69ab0bdcbc5d29baab45
2026-08-21T21:55:49+08:00
Merge remote-tracking branch 'origin/main' into pr-1053
```

Advance this marker only after reviewing the complete old-to-new range, recording design decisions, passing adapter verification, and completing review. Advance it even when the decision is “no adapter change”; otherwise the same upstream commits will be reviewed again.

## What is synchronized

Synchronize behavioral contracts and architecture, not implementation language or file shape.

| Prime Agent source concept | DSH adapter counterpart | Sync policy |
| --- | --- | --- |
| Persistent IPython control environment | The sole `repl` tool + Persistent TypeScript Realm | Use IPython only as a behavioral reference; do not adopt its runtime stack or plan it as a backend |
| Python variables and files as external context | Realm live namespace + workspace handoff/result files | Adapt retrieval, budgeting, snapshot handoff, and recovery behavior |
| `rlm()` admission handle | DSH continuable Subagent id | Preserve admission-first semantics through inbox acceptance and Session persistence |
| `agent_message` replies and family roster | `report`, `send_message`, `list_agents`, and DSH Agent/Subagent services | Reuse DSH direct-parent authority and inboxes; do not invent a second message bus |
| `rlm.list_subagents()` / `delete_subagent()` | `list_agents` / no current delete | Reuse the existing catalog and authority checks; never present interrupt as delete |
| Continual Harness | `refine` | Adapt evidence, scope, concurrency, and rollback rules |
| Manual `/refine` | DSH slash command + independent bounded LLM proposal + existing transactional store | Reuse the receiving Agent route, serialize with maintenance, and fail closed before store apply |
| Auto-refine and separate refine review | Not currently adapted | Re-review the upstream contract before implementation; do not infer it from manual `/refine` |
| Goals, compaction, heartbeat, daemon lifecycle | Existing DSH Goal, Compaction, Jobs, Schedule, and Session capabilities | Compose; do not duplicate |
| Python/kernel-owned MCP programs | DSH Host MCP tool registry + repl cell bindings | Reuse Host connection, authentication, tool-generation, and cleanup ownership; do not create a second MCP runtime inside the Realm |
| TUI, ACP, providers, billing, installer | Outside this plugin | Ignore unless they change an RLM-visible contract |

The compatibility target is the user's experience and safety invariant, not API name parity.

## Upstream watch set

Review at least these Prime Agent paths for every baseline change:

- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/docs/rlm.md`
- `packages/coding-agent/docs/rlm-runtime.md`
- `packages/coding-agent/docs/long-running-agents.md`
- `packages/coding-agent/src/core/prompts/rlm.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-messages.ts`
- `packages/coding-agent/src/core/refinement/`
- `packages/coding-agent/src/core/kernel/`
- `packages/coding-agent/skills/refine/`
- `packages/coding-agent/skills/agent-message/`
- `prime-agent-runtime/src/rlm/`

Also inspect newly added files whose names contain `rlm`, `harness`, `subagent`, `agent-message`, `goal`, `compact`, `heartbeat`, or `schedule`.

## Update procedure

Run these commands from `dsh-prime-agent`. They fetch remote refs but do not modify the checked-out Prime Agent branch:

```powershell
$baseline = (Get-Content -Raw docs/upstream-baseline.json | ConvertFrom-Json).baselineCommit
git -C ../prime-agent status --short
git -C ../prime-agent fetch origin
git -C ../prime-agent log --reverse --format='%H %cI %s' "$baseline..origin/main"
git -C ../prime-agent diff --stat "$baseline..origin/main"
git -C ../prime-agent diff "$baseline..origin/main" -- packages/coding-agent/CHANGELOG.md packages/coding-agent/docs packages/coding-agent/src/core prime-agent-runtime/src/rlm
```

Stop if the upstream checkout has local modifications that overlap the review. Never advance the baseline to an unreviewed moving ref; resolve `origin/main` to an exact commit first.

For every meaningful upstream change, add a row to the decision log below using one of four outcomes:

- **Adopt**: the behavior should be equivalent in DSH.
- **Adapt**: preserve the invariant using DSH-native mechanisms.
- **Defer**: valuable, but depends on an explicit later milestone.
- **Reject**: implementation-specific or conflicts with DSH ownership/safety boundaries.

Before changing code, identify the DSH owner of the behavior. If Agent, Jobs, Subagent, Goal, Session, Code Runtime, or Compaction already owns it, change this plugin only when an adapter or prompt contract is genuinely missing.

## Required verification

After a synchronization pass:

1. Update `docs/prime-agent-learnings.md` when the mental model changed.
2. Update `docs/architecture.md`, README, and tool policy when the public behavior changed.
3. Review the packaged Prime preset (`agent-presets/prime/`) against the upstream shipped `code` preset and port model-facing changes that still apply; the Prime preset is an independent agent-plane composition, not a full snapshot copy of the shipped preset.
4. Add a regression test for every adopted or adapted contract.
5. Run `npm run check:all`.
6. Run the real DSH composition test covering repl, Subagent, and Jobs.
7. Review quotas, authority, cancellation, durability, replay visibility, and failure behavior.
8. Review the final diff for accidental Prime implementation coupling.
9. Update `upstream-baseline.json` to the exact reviewed commit and date.

## Decision log

| Reviewed baseline | Upstream change | Decision | Adapter result |
| --- | --- | --- | --- |
| `7787f074` | Admission-first `rlm()`, explicit child reporting, recoverable child handles | Adapt | A continuable Subagent returns a durable child id; DSH Session owns recovery and the child reports explicitly |
| `7787f074` | Persistent IPython as the only model-facing control plane | Adapt | The `repl` tool is the sole surface; the agent scope resolves each session's Realm identity from the trusted `exec.agent.id`, and the host `primeRealmRuntime` service admits Prime sessions into a Persistent TypeScript Realm while ordinary sessions retain the official one-shot runtime |
| `7787f074` | Local/global Continual Harness with refine/rollback | Adapt | `refine` is secondary, evidence-gated, optimistic, bounded, and conflict-safe |
| `aacf04b4` | Agent-callable Python `refine` Skill only schedules turn-end refinement while the Host owns planning/storage and resumes the Agent | Adapt | Prime registers a packaged DSH `refine` Skill provider; a leased Realm `refine.status/run` client that is absent from the tool SDK returns immediately, `agent/turn-stopping` runs the shared planner/store, and `agent.steer()` resumes the Agent; store CRUD is absent from the model SDK |
| `7787f074` | Host owns agent lifecycle, messages, goals, and cancellation | Adopt | The plugin composes DSH services and creates no worker registry or second Agent Loop |
| `7787f074` | Automatic refinement enabled by default | Defer | Requires explicit proposal/review/outcome design before model-authored automation |
| `aacf04b4` | Nonblocking long-work loops, parallel independent workers, and proactive root progress | Adapt | Policy uses continuable children or Jobs, retains ids/output locations, forbids sleep polling and long blocking awaits, and gives milestone-progress guidance only to user-facing roots |
| `aacf04b4` | Explicit per-child reasoning-level selection and validation | Defer | DSH 0.1.1-rc.2 exposes no per-spawn reasoning parameter; wait for DSH-native inheritance, model validation, persistence, and cold-resume semantics instead of wrapping a second tool |
| `aacf04b4` | Per-variable IPython snapshot limits and compaction-time oversized-state pruning | Adapt | The TypeScript Realm has no heap snapshots or compaction GC; large material uses task files, projections use a 12KB best-effort spill threshold, compact indices/summaries remain live, and user bindings are never deleted implicitly |
| `aacf04b4` | Resume unfinished work and Goal continuation after automatic compaction | Adopt | DSH Compaction and the Agent Loop already own continuation and overflow retry; the plugin composes them and injects no second continuation |
| `aacf04b4` | Daemon-owned family ledger and child deletion/tombstones | Adopt | DSH Agent/Subagent/Session remain family authority; the plugin creates no ledger and never presents interrupt as delete |
| `aacf04b4` | Generic kernel-owned MCP and ACP MCP programs | Adapt | A profile may register MCP tools through the DSH Host client and repl cells gain `tools.*` bindings from the unified catalog; Python/kernel and ACP-specific implementations are rejected |
| `aacf04b4` | Kernel cold-boot, owner-death, and Windows cleanup hardening | Adapt | The Realm reuses Worker generation fencing, parent-process monitoring, quiescent disposal, and cross-process leases; Jupyter, ZMQ, forkserver, and named-pipe details are not ported |

## Local breaking-switch record

This record is not an upstream baseline change; it documents one destructive replacement of the shipped shape in this repository. Review upstream with the current shape in mind and do not regress to the old dual-track design.

- **Replace**: The model-visible entry changed from `run_code` (Code Mode SDK) to the sole `repl` tool; `run_code`, Code Mode SDK assembly, the hybrid route, and the model-visible `prime_realm_identity` handshake were removed. `repl` takes a single `{ code }` argument.
- **Trusted routing**: Identity no longer passes through the model or a handshake; the agent scope resolves a stable Realm identity from the trusted `exec.agent.id`, and the host `primeRealmRuntime` service admits runs by that id. Missing trusted execution context fails closed.
- **Coexist**: The official `code-runtime` row is untouched; non-Prime sessions keep the official one-shot semantics with no fallback.
- **Upgrade note**: Old `run_code` calls, old Code Mode compositions, and old live namespaces do not migrate; there is no alias, feature flag, or silent downgrade, and rollback means reverting the whole version.

## Semantic gaps to re-check each time

- Prime child answers can inform the parent's active computation. DSH 0.1.1-rc.2 now owns this invariant: the official `tool-subagent-report` defaults to `next-step`, and the continuation manager calls `parent.steer()` so a running parent consumes the report at its nearest step while an idle parent wakes. The manager also owns waking accounting and report-before-settlement FIFO. This plugin composes that capability directly and no longer replaces the report row or maintains a private adapter.
- Prime's Python heap preserves live objects and functions; the current adapter selects a Persistent TypeScript Realm through the Realm identity resolved from the trusted `exec.agent.id` and retains TypeScript live objects inside one Worker generation. IPython remains reference material for behavior and failure semantics, not a product backend.
- Unlike the shipped `code` preset, the Prime preset does not register a second scoped `tool-skill`: the Host already owns the catalog/loader, and a same-name shadow prevents its visibility-matched pre-step hook from adding the merged Skill catalog to the first model request. The scoped filesystem provider remains so project and user Skill roots still contribute.
- The Prime preset additionally composes DSH's official owner-isolated Terminal, selecting Bash on POSIX and PowerShell on Windows. Regex output subscriptions come from the companion `dsh-tool-monitor` profile bundle; the Monitor replaces only the concrete `jobs-local` adapter and does not duplicate Terminal or Jobs ownership, sandbox, or cancellation policy. Prime also disables the global `workflow`/`ralph` tools through its scoped restriction and removes the duplicate preset-local `tool-ralph` row; the internal Subagent spawn provider remains available.
- Cross-agent context currently uses workspace handoff files. Write-once behavior is a policy convention; there is no separate Capsule store, `share`/`mount`, or file-access grant.
- The model may load the `refine` Skill and schedule turn-end refinement, while humans may invoke `/refine`; both reuse the bounded planner and revision-checked store. Interval/compaction auto-refine and outcome observation remain disabled.
- Prime can select a reasoning level for one child; DSH 0.1.1-rc.2 currently has no corresponding per-spawn Subagent parameter.
- Prime compaction removes oversized Python variables that cannot enter a bounded snapshot; DSH compaction does not traverse, snapshot, or prune Realm heap. Spilling bounds model projections and logs only on the best-effort path, preserves inline results on failure, and leaves artifact lifecycle to the DSH store/deployment layer.
- Prime MCP programs run in Kernel/ACP runtimes; the DSH counterpart belongs to the Host tool registry, so only MCP clients/tools explicitly installed by the profile enter the repl cell bindings.

These gaps are deliberate until a product requirement and a DSH-native ownership path justify closing them.
