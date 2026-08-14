function orchestrationPolicy(ctx, agent, requireTools) {
    const subagentNames = ['subagent', 'subagent_fork'].filter(name => ctx.tools.get(name, agent) !== undefined);
    const jobNames = ['job_output', 'job_list', 'job_kill'].filter(name => ctx.tools.get(name, agent) !== undefined);
    if (requireTools && agent !== undefined && (subagentNames.length === 0 || !jobNames.includes('job_output'))) {
        const missing = [subagentNames.length === 0 ? 'subagent or subagent_fork' : '', !jobNames.includes('job_output') ? 'job_output' : '']
            .filter(Boolean).join(', ');
        throw new Error(`dsh-prime-agent: RLM orchestration requires visible ${missing}; use a DSH preset that composes delegation and jobs`);
    }
    const subagents = subagentNames.join(', ') || '(not composed)';
    const jobs = jobNames.join(', ') || '(not composed)';
    return `Prime control-plane policy:
- Use Code Mode as the control plane. Compose independent reads and tool/subagent calls in one program.
- Parallelism has three shapes: bare Promise.all only for an atomic group where every result is required; best-effort probes with a per-call catch or Promise.allSettled; side-effecting mutations sequentially, one at a time.
- Realm state is the working namespace and persists across run_code calls in this session: assign intermediate values, helper functions, and progress to state instead of recomputing, re-reading, or redeclaring them in every program.
- Reduce first, return second: filter, aggregate, count, hash, or extract large tool results inside the program, and keep only the reduced form in state. When a result carries a spill locator, read the span you need from it instead of pulling the whole text back.
- Realm state is live-only. Checkpoint anything that must survive a restart — progress ledgers, collected results — to durable task files at phase boundaries.
- A failed tool call is a fact, not a transient condition: capture it, report which operation failed and whether a side effect already happened, and do not blindly repeat it. Side effects stand until you undo them explicitly.
- On a sandbox denial, ask once for the minimum permission covering the same operation, unchanged. If that is refused, stop and report; never switch commands or tools to route around a denial, guard, or approval rejection.
- After a generation-loss notice, live-only state is gone: rebuild from durable checkpoints and the task's own files, and check real external state before compensating for a side effect that may already have happened.
- Visible delegation tools: ${subagents}. Visible job controls: ${jobs}.
- For admission-first work, use a visible subagent tool's background option, retain its returned job handle, continue other work, and collect with job_output. DSH owns cancellation, delivery, and lifecycle.
- Continual refinement is secondary: update it only for repeated failures, user corrections, or stable reusable routing lessons.`;
}
/** Register the Prime control-plane policy prompt section. */
export function registerPolicy(ctx, config) {
    ctx.systemPrompt.section({
        name: 'prime-agent:rlm-policy',
        order: 110,
        text: assembly => orchestrationPolicy(ctx, assembly.agent, config.requireOrchestrationTools),
    });
}
//# sourceMappingURL=policy.js.map