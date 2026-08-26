# Refine

Refinement reviews the conversation and applies small, evidence-backed updates to stable prompt notes, memories, reusable skills, or subagent roles. It runs after the current turn reaches its stopping boundary.

Use it after a repeated failure, a reusable tactic, a durable user correction or preference, or evidence that an existing learning entry is wrong. Do not use it for current task progress, temporary state, research material, or raw tool output.

In the TypeScript code passed to `repl`, call the preloaded `refine` helper. It is not under `tools.*`:

~~~ts
await refine.status()
await refine.run()
await refine.run('remember the validated tactic')
await refine.run('persist this cross-session preference', { scope: 'global' })
~~~

A run request returns immediately. One request per turn is enough; another request before the turn stops updates the pending scope and instructions. Continue the current task normally. After refinement finishes, the Agent receives the result and continues with a rebuilt prompt. Prefer local scope; global scope may be disabled by deployment policy.
