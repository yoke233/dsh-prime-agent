import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** Control-plane policy registration configuration resolved by the root plugin. */
export interface PolicyConfig {
  requireOrchestrationTools: boolean
}

function orchestrationPolicy(ctx: Context, agent: Agent | undefined, requireTools: boolean): string {
  const subagentNames = ['subagent', 'subagent_fork'].filter(name => ctx.tools.get(name, agent) !== undefined)
  const childControlNames = ['list_agents', 'send_message', 'interrupt_agent'].filter(name => ctx.tools.get(name, agent) !== undefined)
  const jobNames = ['job_output', 'job_list', 'job_kill'].filter(name => ctx.tools.get(name, agent) !== undefined)
  if (requireTools && agent !== undefined && (subagentNames.length === 0 || !jobNames.includes('job_output'))) {
    const missing = [subagentNames.length === 0 ? 'subagent or subagent_fork' : '', !jobNames.includes('job_output') ? 'job_output' : '']
      .filter(Boolean).join(', ')
    throw new Error(`dsh-prime-agent: RLM orchestration requires visible ${missing}; use a DSH preset that composes delegation and jobs`)
  }
  const subagents = subagentNames.join(', ') || '(not composed)'
  const childControls = childControlNames.join(', ') || '(not composed)'
  const jobs = jobNames.join(', ') || '(not composed)'
  return `Prime control-plane policy:
- Use Code Mode as the control plane. Compose independent reads and tool/subagent calls in one program.
- Parallelism has three shapes: bare Promise.all only for an atomic group where every result is required; best-effort probes with a per-call catch or Promise.allSettled; side-effecting mutations sequentially, one at a time.
- Each run_code call is the next cell in the same live session; ordinary top-level bindings remain available until the Realm restarts.
- A cell's result is its final expression; do not use a top-level return.
- Reduce first, finish with the summary: filter, aggregate, count, hash, or extract large tool results inside the program, keep reusable intermediates in ordinary top-level bindings, and make only the summary the cell's final expression. When a result carries a spill locator, read the span you need from it instead of pulling the whole text back.
- The live namespace is not durable. Checkpoint anything that must survive a restart — progress ledgers, collected results — to durable task files at phase boundaries.
- A failed tool call is a fact, not a transient condition: capture it, report which operation failed and whether a side effect already happened, and do not blindly repeat it. Side effects stand until you undo them explicitly.
- On a sandbox denial, ask once for the minimum permission covering the same operation, unchanged. If that is refused, stop and report; never switch commands or tools to route around a denial, guard, or approval rejection.
- After a namespace-restart notice, previous bindings are gone: rebuild from durable checkpoints and the task's own files, and check real external state before compensating for a side effect that may already have happened.
- Visible delegation tools: ${subagents}. Visible continuable-child controls: ${childControls}. Visible job controls: ${jobs}.
- For admission-first work, start a continuable child in the background, retain its returned subagent id, and continue useful parent work. Use list_agents for the roster, send_message for a later turn, interrupt_agent to stop only the current child turn, and receive selected conclusions through report or settlement notices. A continuable child is not a Job; never pass its id to job_output.
- Continual refinement is secondary: update it only for repeated failures, user corrections, or stable reusable routing lessons.

Cross-agent handoff by file:
- Material travels by file, instructions travel in the prompt. Serialize what the child needs as JSON into one workspace handoff file, converting what JSON cannot carry (functions, Map/Set, class instances) explicitly before you write. A handoff file is not edited after it is written; new data means a new file.
- The spawn prompt reaches the child verbatim and has no length ceiling: carry the task statement, the handoff file path, and a catalog of that file — one line per key with a summary and its rough size. How to do the work, the constraints, and what to report belong in the prompt; never bury task instructions in a data file.
- A handoff file is a snapshot of the moment it was written. Later changes on your side do not reach a running child, and the child must not wait for a value to update; write a new file and tell the child its path.
- Unless explicitly overridden, a child inherits your working directory and composes the parent preset; child-level tool restrictions may narrow that catalog. It reads from the file only the keys its current decision needs, reduces them inside its own program, and lets only that summary into its context — the same reduce-first rule, one level down. Its own output goes to a result file.
- The return trip is symmetric: the child's report is a conclusion summary plus the result file path. A foreground subagent's tool result is truncated past 8192 characters while report bodies and workspace files are not, so large material must travel by file and the report must carry only conclusions and paths.
- Handoff and result files are ordinary workspace files: clean them up once no child needs them.`
}

/** Register the Prime control-plane policy prompt section. */
export function registerPolicy(ctx: Context, config: PolicyConfig): void {
  ctx.systemPrompt.section({
    name: 'prime-agent:rlm-policy',
    order: 110,
    text: assembly => orchestrationPolicy(ctx, assembly.agent, config.requireOrchestrationTools),
  })
}
