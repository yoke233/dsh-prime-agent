import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionInput, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createReplBindings } from '../src/repl/bridge.js'

function success(value: unknown, additionalContexts: unknown[] = []): ToolExecutionResult {
  return { isError: false, value, content: [], additionalContexts, concludesTurn: false } as ToolExecutionResult
}

function harness(names: string[], execute: (input: ToolExecutionInput) => Promise<ToolExecutionResult>, mode: (name: string) => 'parallel' | 'exclusive' = () => 'parallel') {
  const deferred: unknown[] = []
  const agent = { id: 'bridge-agent' } as unknown as Agent
  const token = { opaque: 'parent' } as unknown as ToolRunContext['token']
  const signal = new AbortController().signal
  const ctx = { tools: {
    schemas: () => names.map(name => ({ name })),
    executionMode: (input: ToolExecutionInput) => ({ kind: mode(input.name) }),
    execute,
  } } as unknown as Context
  const exec = {
    agent, token, signal, callId: 'outer-call', rootCallId: 'root-call',
    deferContext: (value: unknown) => { deferred.push(value) },
    concludeTurn: () => {},
  } as unknown as ToolRunContext
  return { leased: createReplBindings(ctx, exec), agent, token, signal, deferred }
}

function namespace(bindings: ReturnType<typeof createReplBindings>['bindings'], global: string) {
  const found = bindings.find(item => item.global === global)
  if (found === undefined) throw new Error('missing namespace ' + global)
  return found.functions
}

describe('REPL capability bridge', () => {
  it('routes raw tools and Agent/Job aliases through trusted nested execution context', async () => {
    const inputs: ToolExecutionInput[] = []
    const h = harness([
      'echo', 'repl', 'subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent',
      'job_list', 'job_output', 'job_kill',
    ], async input => { inputs.push(input); return success({ name: input.name }) })

    const tools = namespace(h.leased.bindings, 'tools')
    const agents = namespace(h.leased.bindings, 'agents')
    const jobs = namespace(h.leased.bindings, 'jobs')
    expect(Object.keys(tools)).toContain('echo')
    expect(Object.keys(tools)).not.toContain('repl')
    expect(await tools.echo!({ value: 1 })).toEqual({ name: 'echo' })
    expect(await agents.spawn!({ prompt: 'x' })).toEqual({ name: 'subagent' })
    expect(await agents.fork!({ prompt: 'x' })).toEqual({ name: 'subagent_fork' })
    expect(await jobs.list!({})).toEqual({ name: 'job_list' })

    expect(inputs.map(input => input.name)).toEqual(['echo', 'subagent', 'subagent_fork', 'job_list'])
    for (const input of inputs) {
      expect(input.agent).toBe(h.agent)
      expect(input.parent).toBe(h.token)
      expect(input.signal).toBe(h.signal)
      expect(String(input.rootCallId)).toBe('root-call')
      expect(String(input.callId)).toMatch(/^outer-call:repl:\d+$/)
    }
    await h.leased.finish()
  })

  it('runs parallel calls together but keeps an exclusive submission barrier', async () => {
    const starts: string[] = []
    const releases = new Map<string, () => void>()
    const h = harness(['first', 'barrier', 'last'], input => new Promise(resolve => {
      starts.push(input.name)
      releases.set(input.name, () => resolve(success(input.name)))
    }), name => name === 'barrier' ? 'exclusive' : 'parallel')
    const tools = namespace(h.leased.bindings, 'tools')
    const first = tools.first!({})
    const barrier = tools.barrier!({})
    const last = tools.last!({})
    await Promise.resolve()
    expect(starts).toEqual(['first'])
    releases.get('first')!()
    await first
    await Promise.resolve()
    expect(starts).toEqual(['first', 'barrier'])
    releases.get('barrier')!()
    await barrier
    await Promise.resolve()
    expect(starts).toEqual(['first', 'barrier', 'last'])
    releases.get('last')!()
    await last
    await h.leased.finish()
  })

  it('commits additional contexts in submission order even when parallel calls settle out of order', async () => {
    const releases = new Map<string, () => void>()
    const h = harness(['slow', 'fast'], input => new Promise(resolve => {
      releases.set(input.name, () => resolve(success(input.name, [{ role: input.name }])))
    }))
    const tools = namespace(h.leased.bindings, 'tools')
    const slow = tools.slow!({})
    const fast = tools.fast!({})
    releases.get('fast')!()
    await Promise.resolve()
    expect(h.deferred).toEqual([])
    releases.get('slow')!()
    await Promise.all([slow, fast])
    expect(h.deferred).toEqual([{ role: 'slow' }, { role: 'fast' }])
    await h.leased.finish()
  })
})
