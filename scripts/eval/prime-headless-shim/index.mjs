// Test-only copy of @deepseek-ai/dsh-headless lib/index.js with two additions:
// mount the roster's default preset, and force exit only if a handle remains
// after the launcher's graceful shutdown. Task text arrives via the
// headlessStartup service instead of row config so this row needs no Config.
import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'prime-headless-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets', 'headlessStartup']

function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

async function run(ctx, task, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return
  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async agentCtx => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await ctx.agentPresets.mount(agentCtx)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  const exitCode = outcome.reason?.kind === 'completed' ? 0 : 1
  io.exit(exitCode)
  setTimeout(() => process.exit(exitCode), 6_000).unref()
}

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('prime-headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  const task = ctx.get('headlessStartup')?.task
  if (task === undefined) return
  run(ctx, task, io).catch(error => {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
