# Prime Agent upstream synchronization manual

[简体中文](upstream-sync.zh.md)

This manual keeps `dsh-prime-agent` aligned with Prime Agent's design without turning the adapter into a source-code fork. The machine-readable baseline is [upstream-baseline.json](upstream-baseline.json).

## Baseline rule

The current reviewed Prime Agent baseline is:

```text
7787f07415d843b9a800f6a4720e0c739bd608e5
2026-08-12T21:01:27-07:00
fix(coding-agent): retain root kill cleanup ownership (#1240)
```

Advance this marker only after reviewing the complete old-to-new range, recording design decisions, passing adapter verification, and completing review. Advance it even when the decision is “no adapter change”; otherwise the same upstream commits will be reviewed again.

## What is synchronized

Synchronize behavioral contracts and architecture, not implementation language or file shape.

| Prime Agent source concept | DSH adapter counterpart | Sync policy |
| --- | --- | --- |
| Persistent IPython control environment | v0.2 ephemeral Code Mode + durable data; v0.3 Persistent TypeScript Realm | Use IPython only as a behavioral reference; do not adopt its runtime stack or plan it as a backend |
| Python variables and files as external context | Manifest catalog and content-addressed blobs | Adapt retrieval, budgeting, and recovery behavior |
| `rlm()` admission handle | DSH Subagent background admission and Job id | Preserve admission-first semantics using DSH lifecycle ownership |
| `agent_message` replies and family roster | DSH completion delivery, `job_output`, and available Agent/Subagent services | Review semantic gaps; never invent a second message bus casually |
| `rlm.list_subagents()` / `delete_subagent()` | DSH job/subagent observation and cancellation tools | Reuse installed tools and their authority checks |
| Continual Harness | `prime_refine` | Adapt evidence, scope, concurrency, and rollback rules |
| Auto-refine and refine review | Future learning-loop work | Defer until proposals, approvals, and outcome observation are explicit |
| Goals, compaction, heartbeat, daemon lifecycle | Existing DSH Goal, Compaction, Jobs, Schedule, and Session capabilities | Compose; do not duplicate |
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
2. Update `docs/v2-architecture.md`, README files, and tool policy when the public behavior changed.
3. Diff the packaged Prime preset (`agent-presets/prime/`, once it ships) against the upstream shipped `code` preset and port composition changes; it is a full copy because DSH has no preset inheritance.
4. Add a regression test for every adopted or adapted contract.
5. Run `npm run check`.
6. Run the real DSH composition test covering Code Mode, Subagent, and Jobs.
7. Review quotas, authority, cancellation, durability, replay visibility, and failure behavior.
8. Review the final diff for accidental Prime implementation coupling.
9. Update `upstream-baseline.json` to the exact reviewed commit and date.

## Decision log

| Reviewed baseline | Upstream change | Decision | Adapter result |
| --- | --- | --- | --- |
| `7787f074` | Admission-first `rlm()`, explicit child reporting, recoverable child handles | Adapt | Background DSH Subagent returns a Job id; parent continues and later collects through `job_output` |
| `7787f074` | Persistent IPython as the only model-facing control plane | Adapt | Code Mode remains the sole surface; v0.3 will use an authenticated `prime_realm_identity` binding handshake to route Prime sessions into a Persistent TypeScript Realm while ordinary sessions retain the official one-shot runtime |
| `7787f074` | Local/global Continual Harness with refine/rollback | Adapt | `prime_refine` is secondary, evidence-gated, optimistic, bounded, and conflict-safe |
| `7787f074` | Host owns agent lifecycle, messages, goals, and cancellation | Adopt | The plugin composes DSH services and creates no worker registry or second Agent Loop |
| `7787f074` | Automatic refinement enabled by default | Defer | Requires explicit proposal/review/outcome design before model-authored automation |

## Semantic gaps to re-check each time

- Prime child answers can inform the parent's active computation. Implemented: the bundle patch retires the host `tool-subagent-report` (fixed `wakeup`, one separate later turn per report) and mounts `dsh-prime-agent/subagent-report`, which chooses the delivery per call over the public `reportFrom` — `quiet` for a running parent (inject → the current turn's next step, exactly where a steer would land) and `wakeup` for an idle one. No DSH source change and no plugin-private inbox. Remaining upstream ask: a DSH-native steer delivery (with a wake) would close the narrow busy→idle window in which a quiet report waits for the child's settled notice to wake the parent.
- Prime's Python heap preserves live objects and functions; v0.2 preserves only JSON, text, and artifact references. The planned [v0.3 P0](v0.3-roadmap.md) will close the cross-turn computation gap with a Persistent TypeScript Realm selected through a plugin-private authenticated binding handshake. IPython remains reference material for behavior and failure semantics, not a product backend.
- v0.2 has no immutable context capsule `share`/`mount` contract and no blob garbage collection; these are deferred to v0.4.
- `prime_refine` is explicit; it does not yet observe outcomes or propose refinements automatically.

These gaps are deliberate until a product requirement and a DSH-native ownership path justify closing them.
