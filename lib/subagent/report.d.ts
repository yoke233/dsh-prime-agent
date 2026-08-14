/**
 * Prime-form `report` delivery for continuable children.
 *
 * The harness's own `tool-subagent-report` schedules every accepted report with
 * one FIXED policy (`wakeup` → a new parent turn, or `quiet` → next-step without
 * a wake). The Prime Agent prototype instead schedules the child's message by
 * the PARENT's momentary state — a busy parent folds it into the turn already
 * running, an idle parent is prompted with one turn. This plugin reproduces that
 * form on top of the harness by choosing the delivery per call:
 *
 *   parent is running → `quiet`  (inject → parent's `next-step`; the busy parent
 *                                 claims it at its next step, exactly where a
 *                                 `steer` would land — no wake is needed because
 *                                 the parent is already running)
 *   otherwise         → `wakeup` (followup → parent's `next-turn`; an idle
 *                                 parent runs one ordinary turn, i.e. "prompt")
 *
 * Delivery still goes through `ctx.subagents.reportFrom`, so the continuation
 * manager keeps ownership authorization and the accepted-message accounting.
 * The reporting child is one of its parent's live owned children for the whole
 * call, which pins the parent in `waiting`; it therefore cannot be judged
 * settled while a report is in flight, and neither delivery races its teardown.
 *
 * This replaces the host `tool-subagent-report` (disabled in `cordis.patch.yml`)
 * so that a continuable child sees exactly one `report` tool.
 *
 * @module dsh-prime-agent/subagent-report
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "prime-subagent-report";
export declare const inject: string[];
/**
 * Install the Prime-form `report` tool and its usage guidance into one
 * continuable child's scope. Both registrations are owned by that scope and are
 * therefore invisible to the child's parent and siblings.
 * @param childCtx - child-scoped context receiving the tool and the guidance.
 * @param ctx - service context used for parent lookup and delivery.
 * @returns disposer that attempts both child registrations before reporting cleanup failures.
 */
export declare function installPrimeReport(childCtx: Context, ctx: Context): () => void;
/**
 * Register the Prime-form continuable-child report contribution. Host-plane and
 * process-global: it installs one `report` tool into every continuable child.
 * @param ctx - context carrying the subagent service, the agent registry, tools, and the system prompt.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=report.d.ts.map