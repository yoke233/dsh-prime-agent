function missingOrchestrationCapabilities(ctx, agent) {
    const missing = [];
    if (ctx.tools.get('subagent', agent) === undefined && ctx.tools.get('subagent_fork', agent) === undefined) {
        missing.push('subagent or subagent_fork');
    }
    for (const name of ['list_agents', 'send_message', 'interrupt_agent', 'job_output', 'job_list', 'job_kill']) {
        if (ctx.tools.get(name, agent) === undefined)
            missing.push(name);
    }
    return missing;
}
function orchestrationPolicy(ctx, agent, requireTools) {
    if (requireTools && agent !== undefined) {
        const missing = missingOrchestrationCapabilities(ctx, agent);
        if (missing.length > 0) {
            throw new Error(`dsh-prime-agent: REPL orchestration requires host capabilities: ${missing.join(', ')}`);
        }
    }
    const rootProgressPolicy = agent !== undefined && ctx.get('agents')?.roots().includes(agent) === true
        ? '\n- For planned, multi-turn, or multi-agent work, give concise progress updates at meaningful milestones and before ending a turn while work remains.'
        : '';
    return `Orchestration guidance:
- Use the preloaded tools, agents, and jobs shown below. Keep a simple action simple; introduce loops, helpers, parallelism, agents, or jobs only when the task benefits.
- Assign intermediate results you will reuse.
- Parallelize independent read-only work. Run dependent steps in order, and serialize side-effecting mutations unless the underlying operation explicitly supports safe concurrency.
- Use Promise.all only when every result is required. For independent best-effort probes, use Promise.allSettled or catch each ToolCallError individually; inspect failures and rethrow unexpected errors.
- Use edit for one exact in-place replacement, apply_patch for related Add/Update changes, and write only when intentionally replacing a complete file. apply_patch writes files in order; after a failure, inspect which files changed before continuing.
- For slow or independently completing work, start an agent or job, retain its handle, continue only independent useful work, and inspect it after a report, completion notice, or later turn. Do not sleep or busy-poll.
- Agent handles and job ids are different. Use agents for continuable conversations and jobs for one-shot background work.
- Small, self-contained agent context belongs directly in its prompt. Use files for large material, structured snapshots, binary data, or information that must survive a restart.
- Save irreplaceable progress and large source data to files; variables may be lost after a restart.
- A failed call is a real outcome: determine whether a side effect happened before retrying or compensating. Never route around a denial or approval rejection.
- After a restart notice, rebuild from files and verify external state before resuming mutations.${rootProgressPolicy}`;
}
/** Register concise guidance for the persistent REPL. */
export function registerPolicy(ctx, config) {
    ctx.systemPrompt.section({
        name: 'prime-agent:rlm-policy',
        order: 110,
        text: assembly => orchestrationPolicy(ctx, assembly.agent, config.requireOrchestrationTools),
    });
}
//# sourceMappingURL=policy.js.map