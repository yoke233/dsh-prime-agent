import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CodeBindingFunction, CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime'
import type {
  CodeDispatchLog,
  JsonValue,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'

export const REPL_TOOL_NAME = 'repl'
type DispatchMode = 'parallel' | 'exclusive'
type Pending = { mode: DispatchMode; start: () => void; reject: (error: Error) => void }

/** Submission-ordered scheduler: parallel calls overlap until an exclusive barrier. */
class ReplDispatchQueue {
  private readonly pending: Pending[] = []
  private readonly inFlight = new Set<Promise<void>>()
  private exclusive = false
  private closed = false

  enqueue<T>(mode: DispatchMode, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('repl cell is over; tool call not dispatched'))
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ mode, reject, start: () => {
        if (mode === 'exclusive') this.exclusive = true
        let flight!: Promise<void>
        flight = operation().then(resolve, reject).then(() => undefined).finally(() => {
          this.inFlight.delete(flight)
          if (mode === 'exclusive') this.exclusive = false
          this.pump()
        })
        this.inFlight.add(flight)
      } })
      this.pump()
    })
  }

  close(): void {
    this.closed = true
    for (const item of this.pending.splice(0)) item.reject(new Error('repl cell is over; queued tool call cancelled'))
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  private pump(): void {
    if (this.exclusive) return
    while (this.pending.length > 0) {
      const head = this.pending[0]!
      if (head.mode === 'exclusive') {
        if (this.inFlight.size > 0) return
        this.pending.shift()
        head.start()
        return
      }
      this.pending.shift()
      head.start()
    }
  }
}

function forwardResult(exec: ToolRunContext, result: ToolExecutionResult): void {
  if (!result.isError && result.content.some(block => block.type === 'image')) {
    exec.deferContext(createUserMessage({ content: result.content, source: { kind: 'plugin', plugin: 'repl' } }))
  }
  for (const context of result.additionalContexts ?? []) exec.deferContext(context)
  if (!result.isError && result.concludesTurn) exec.concludeTurn()
}

function officialPresentation(result: ToolExecutionResult): string | undefined {
  if (result.content.length === 0) return undefined
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function dispatchLogContent(
  ctx: Context,
  dispatch: CodeDispatchLog,
): Promise<ToolExecutionResult['content']> {
  try {
    return await ctx.waterfall(
      'tools/code-dispatch-log',
      dispatch,
      () => Promise.resolve(dispatch.content),
    )
  } catch {
    return dispatch.content
  }
}

export interface ReplBindings {
  bindings: CodeBindingNamespace[]
  finish(): Promise<void>
}

/** Build one cell's leased host capabilities from the calling Agent's catalog. */
export function createReplBindings(ctx: Context, exec: ToolRunContext): ReplBindings {
  const agent = exec.agent
  if (agent === undefined) throw new Error('repl requires an owning agent session')
  const queue = new ReplDispatchQueue()
  let dispatchNumber = 0
  let commitTail: Promise<void> = Promise.resolve()

  const binding = (toolName: string): CodeBindingFunction => async (argumentsValue: unknown): Promise<JsonValue> => {
    const subCallId = CallId(String(exec.callId) + ':repl:' + String(++dispatchNumber))
    const rootCallId = exec.rootCallId ?? exec.callId
    const input: ToolExecutionInput = {
      callId: subCallId,
      rootCallId,
      name: toolName,
      arguments: argumentsValue,
      agent,
      parent: exec.token,
      signal: exec.signal,
    }
    const mode: DispatchMode = ctx.tools.executionMode(input).kind === 'parallel' ? 'parallel' : 'exclusive'
    const previousCommit = commitTail
    let releaseCommit!: () => void
    commitTail = new Promise<void>(resolve => { releaseCommit = resolve })
    try {
      const result = await queue.enqueue(mode, async () => {
        agent.session.append('tool/code-dispatch-start', {
          rootCallId,
          parentCallId: exec.callId,
          subCallId,
          name: toolName,
          arguments: argumentsValue as JsonValue,
        })
        return await ctx.tools.execute(input)
      })
      await previousCommit
      const content = await dispatchLogContent(ctx, {
        exec,
        agent,
        subCallId,
        name: toolName,
        isError: result.isError,
        content: result.content,
      })
      agent.session.append('tool/code-dispatch', {
        rootCallId,
        parentCallId: exec.callId,
        subCallId,
        name: toolName,
        arguments: argumentsValue as JsonValue,
        isError: result.isError,
        content,
      })
      forwardResult(exec, result)
      if (result.isError) throw new Error(result.error.message)
      const presentation = officialPresentation(result)
      return presentation === undefined ? result.value : {
        $dshPrimeBinding: 'presentation-v1',
        value: result.value,
        presentation,
      }
    } finally {
      releaseCommit()
    }
  }

  const raw: Record<string, CodeBindingFunction> = Object.create(null) as Record<string, CodeBindingFunction>
  const available = new Set<string>()
  for (const schema of ctx.tools.schemas(exec.agent)) {
    if (schema.name === REPL_TOOL_NAME) continue
    available.add(schema.name)
    Object.defineProperty(raw, schema.name, { enumerable: true, value: binding(schema.name) })
  }

  const namespace = (global: string, aliases: Record<string, string>): CodeBindingNamespace | undefined => {
    const functions: Record<string, CodeBindingFunction> = Object.create(null) as Record<string, CodeBindingFunction>
    for (const [member, target] of Object.entries(aliases)) {
      if (available.has(target)) Object.defineProperty(functions, member, { enumerable: true, value: binding(target) })
    }
    return Object.keys(functions).length === 0 ? undefined : { global, functions }
  }

  const bindings: CodeBindingNamespace[] = [{ global: 'tools', functions: raw, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
  const agents = namespace('agents', {
    spawn: available.has('subagent') ? 'subagent' : 'subagent_fork',
    fork: 'subagent_fork', list: 'list_agents', send: 'send_message', interrupt: 'interrupt_agent',
  })
  const jobs = namespace('jobs', { list: 'job_list', output: 'job_output', kill: 'job_kill' })
  if (agents !== undefined) bindings.push(agents)
  if (jobs !== undefined) bindings.push(jobs)
  return { bindings, async finish() { queue.close(); await queue.drain(); await commitTail } }
}
