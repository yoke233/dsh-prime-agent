import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** Control-plane policy registration configuration resolved by the root plugin. */
export interface PolicyConfig {
  requireOrchestrationTools: boolean
}

function missingOrchestrationCapabilities(ctx: Context, agent: Agent): string[] {
  const missing: string[] = []
  if (ctx.tools.get('subagent', agent) === undefined && ctx.tools.get('subagent_fork', agent) === undefined) {
    missing.push('subagent or subagent_fork')
  }
  for (const name of ['list_agents', 'send_message', 'interrupt_agent', 'job_output', 'job_list', 'job_kill']) {
    if (ctx.tools.get(name, agent) === undefined) missing.push(name)
  }
  return missing
}

function orchestrationPolicy(ctx: Context, agent: Agent | undefined, requireTools: boolean): string {
  if (requireTools && agent !== undefined) {
    const missing = missingOrchestrationCapabilities(ctx, agent)
    if (missing.length > 0) {
      throw new Error(`dsh-prime-agent: REPL orchestration requires host capabilities: ${missing.join(', ')}`)
    }
  }

  const rootProgressPolicy = agent !== undefined && ctx.get('agents')?.roots().includes(agent) === true
    ? '\n- For planned, multi-turn, or multi-agent work, give concise progress updates at meaningful milestones and before ending a turn while work remains.'
    : ''

  return `Orchestration guidance:
- TypeScript is the orchestration language: use it for loops, conditionals, parsing, filtering, aggregation, and state. Tool calls are ordinary \`await\` expressions whose typed results you bind, slice, and combine in the same cell; use agents and jobs for work that should run outside the current cell.
- Bind every read, search, and command result to a named variable and continue from it; do not re-run a call whose result is already bound.
- If a file path is uncertain, glob for files under the nearest known existing parent; if a directory path is uncertain, inspect that parent with pwsh. Do not probe guessed layouts.
- Parallelize independent read-only work. Run dependent steps in order, and serialize side-effecting mutations unless the underlying operation explicitly supports safe concurrency. Treat package managers, formatters, builds, and code generation as possible file rewrites; re-read affected files before editing them.
- Use Promise.all only when any failure makes every successful result unusable. For independent reads, searches, and probes—even when every answer is desired—use Promise.allSettled or catch each ToolCallError individually; keep successful results, inspect failures, and retry only failed calls.
- Use edit for one exact in-place replacement, apply_patch for related Add/Update changes, and write only when intentionally replacing a complete file. apply_patch writes files in order; after a failure, inspect which files changed before continuing.
- For slow or independently completing work, start an agent or job, retain its handle, continue only independent useful work, and inspect it after a report, completion notice, or later turn. Do not sleep or busy-poll.
- Agent handles and job ids are different. Use agents for continuable conversations and jobs for one-shot background work.
- Delegate parallel context-heavy research or independent implementation to agents; keep a single known lookup, edit, or command inline. An agent's tool output stays in its own session, so delegate exploration that would flood this conversation (wide searches, long logs, many files) and ask for conclusions, counts, and paths rather than transcripts.
- Small, self-contained agent context belongs directly in its prompt. Use files for large material, structured snapshots, binary data, or information that must survive a restart.
- Save irreplaceable progress and large source data to files; variables may be lost after a restart.
- A failed call is a real outcome: determine whether a side effect happened before retrying or compensating. Never route around a denial or approval rejection.
- After a compacted-summary checkpoint, REPL variables and functions are still alive: continue from them instead of re-reading or recomputing. Only a live-namespace-restarted notice means they were lost; then rebuild from files and verify external state before resuming mutations.${rootProgressPolicy}`
}

/** Register concise guidance for the persistent REPL. */
export function registerPolicy(ctx: Context, config: PolicyConfig): void {
  ctx.systemPrompt.section({
    name: 'prime-agent:rlm-policy',
    order: 110,
    text: assembly => orchestrationPolicy(ctx, assembly.agent, config.requireOrchestrationTools),
  })
}
