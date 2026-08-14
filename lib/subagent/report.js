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
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'prime-subagent-report';
// The registration reaches through `subagents` (setup + delivery), `agents`
// (parent status), and each child's own `tools`/`systemPrompt`. Declaring them
// makes Loader ordering fail at load instead of at the next child materialization.
export const inject = ['subagents', 'agents', 'tools', 'systemPrompt'];
/** Guidance order after every per-tool section a continuable child can carry. */
const REPORT_SECTION_ORDER = 117;
/**
 * Choose the parent scheduling for one report from the parent's momentary state.
 * A running parent already claims `next-step` at its next step, so `quiet`
 * (inject, no wake) folds the report into that turn like Prime's `steer`; any
 * other state (idle, or an unresolvable parent) takes `wakeup` so the parent is
 * prompted with one ordinary turn.
 *
 * Tail window: a parent read as `running` may retire its turn in the same
 * microtask span, leaving the quiet report parked in `next-step` until the
 * next wake — at the latest the child's own `subagent-settled` notice, whose
 * new turn drains the whole `next-step` list. The report is delayed, never
 * lost; a steer would sit in the same window, which is why the harness's own
 * settlement path also relies on the settled wake rather than steer self-heal.
 * @param parent - the live direct parent, or undefined when it cannot be resolved.
 * @returns the `reportFrom` delivery policy.
 */
function primeDelivery(parent) {
    return parent?.status === 'running' ? 'quiet' : 'wakeup';
}
/**
 * Install the Prime-form `report` tool and its usage guidance into one
 * continuable child's scope. Both registrations are owned by that scope and are
 * therefore invisible to the child's parent and siblings.
 * @param childCtx - child-scoped context receiving the tool and the guidance.
 * @param ctx - service context used for parent lookup and delivery.
 * @returns disposer that attempts both child registrations before reporting cleanup failures.
 */
export function installPrimeReport(childCtx, ctx) {
    const disposeSection = childCtx.systemPrompt.section({
        name: 'tool:report',
        order: REPORT_SECTION_ORDER,
        text: 'Deliver your result with the report tool before you finish: call it once with a self-contained '
            + 'answer. The agent that started you shares your workspace but does not automatically receive your '
            + 'transcript, tool output, or reasoning, so a closing remark such as "done" leaves it nothing it can '
            + 'use. Report earlier as well whenever a partial finding changes what that agent should do next; '
            + 'reporting never ends your turn.',
    });
    let disposeTool;
    try {
        disposeTool = childCtx.tools.register(defineTool({
            name: 'report',
            description: 'Report selected content to the agent that started you. Call this once before you finish, with a '
                + 'self-contained final result, and earlier for progress or findings that change what that agent does '
                + 'next. That agent shares your workspace but does not automatically receive your transcript, tool '
                + 'output, or reasoning, so finishing your work is not itself a result. Reporting does not end your '
                + 'turn or finish your work, and only your direct parent receives it. A failed call may still have '
                + 'arrived, so do not blindly repeat it.',
            parameters: {
                output: {
                    type: 'string',
                    required: true,
                    description: 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        messageId: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => [{
                        type: 'text',
                        text: `report accepted by the agent that started you as message ${value.messageId}`,
                    }],
            },
            async execute(args, exec) {
                const content = [{ type: 'text', text: args.output }];
                // Scope-local resolution guarantees an Agent; the service still verifies
                // its exact live Activation identity at the authority boundary.
                const child = exec.agent;
                const parentSession = child.session.header.parentSession;
                const parent = parentSession === undefined ? undefined : ctx.agents.get(parentSession);
                const messageId = await ctx.subagents.reportFrom(child, content, {
                    delivery: primeDelivery(parent),
                    signal: exec.signal,
                });
                return { messageId };
            },
        }));
    }
    catch (error) {
        // A duplicate `report` name here means the host `tool-subagent-report` is
        // still active: its row's id or name drifted upstream, so the disable in
        // this package's cordis.patch.yml was skipped as a warn-and-no-match while
        // this insert still landed. Name the patch instead of leaving each child
        // materialization to fail on a bare duplicate-tool error.
        const diagnosed = new Error('dsh-prime-agent/subagent-report: failed to register the `report` tool for a continuable child. '
            + 'If the cause is a duplicate tool name, the host tool-subagent-report row was not disabled — '
            + "re-sync the report pair in dsh-prime-agent's cordis.patch.yml against the upstream base bundle.", { cause: error });
        try {
            disposeSection();
        }
        catch (rollbackError) {
            throw new AggregateError([diagnosed, rollbackError], 'failed to register the prime report tool and roll back its prompt guidance');
        }
        throw diagnosed;
    }
    return () => {
        const failures = [];
        for (const dispose of [disposeTool, disposeSection]) {
            try {
                dispose();
            }
            catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, 'failed to revoke prime report tool and prompt registrations');
        }
    };
}
/**
 * Register the Prime-form continuable-child report contribution. Host-plane and
 * process-global: it installs one `report` tool into every continuable child.
 * @param ctx - context carrying the subagent service, the agent registry, tools, and the system prompt.
 */
export function apply(ctx) {
    ctx.subagents.registerContinuableSetup(childCtx => installPrimeReport(childCtx, ctx));
}
//# sourceMappingURL=report.js.map