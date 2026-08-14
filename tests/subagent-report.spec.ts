import { describe, expect, it, vi } from 'vitest'
import { installPrimeReport } from '../src/subagent/report.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the test drives the tool through hand-built fakes */

/** A child-scoped context that captures the single tool the install registers. */
function fakeChildCtx() {
  const disposeSection = vi.fn()
  const disposeTool = vi.fn()
  let registered: any
  const childCtx = {
    systemPrompt: { section: vi.fn(() => disposeSection) },
    tools: {
      register: vi.fn((tool: any) => {
        registered = tool
        return disposeTool
      }),
    },
  }
  return { childCtx, disposeSection, disposeTool, tool: () => registered }
}

/** A service context whose parent lookup and delivery are observable. */
function fakeServiceCtx(parent: any) {
  const reportFrom = vi.fn(async () => 'msg-1')
  const get = vi.fn(() => parent)
  const ctx = { agents: { get }, subagents: { reportFrom } }
  return { ctx, reportFrom, get }
}

/** A reporting child whose durable header names its parent. */
function childExec(parentSession: string | undefined) {
  return {
    agent: { id: 'child-1', session: { header: { parentSession } } },
    signal: new AbortController().signal,
  }
}

async function runReport(parent: any, ...parentSessionArg: [] | [string | undefined]) {
  // Spread avoids the default-parameter trap: an explicit `undefined` must stay
  // undefined (child with no parent header), not fall back to a default.
  const parentSession = parentSessionArg.length === 0 ? 'parent-1' : parentSessionArg[0]
  const child = fakeChildCtx()
  const service = fakeServiceCtx(parent)
  installPrimeReport(child.childCtx as any, service.ctx as any)
  const exec = childExec(parentSession)
  const result = await child.tool().execute({ output: 'the finding' }, exec as any)
  return { child, service, exec, result }
}

describe('prime-form subagent report delivery', () => {
  it('folds a report into a running parent with quiet (next-step, no wake)', async () => {
    const { service, exec, result } = await runReport({ status: 'running' })
    expect(service.get).toHaveBeenCalledWith('parent-1')
    expect(service.reportFrom).toHaveBeenCalledTimes(1)
    const [child, content, options] = service.reportFrom.mock.calls[0]
    expect(child).toBe(exec.agent)
    expect(content).toEqual([{ type: 'text', text: 'the finding' }])
    expect(options.delivery).toBe('quiet')
    expect(options.signal).toBe(exec.signal)
    expect(result).toEqual({ messageId: 'msg-1' })
  })

  it('prompts an idle parent with wakeup (one ordinary turn)', async () => {
    const { service } = await runReport({ status: 'idle' })
    expect(service.reportFrom.mock.calls[0]![2].delivery).toBe('wakeup')
  })

  it('treats an unresolvable parent as wakeup rather than failing to schedule', async () => {
    const { service } = await runReport(undefined)
    expect(service.get).toHaveBeenCalledWith('parent-1')
    expect(service.reportFrom.mock.calls[0]![2].delivery).toBe('wakeup')
  })

  it('takes wakeup and never looks up a parent when the child has no parent header', async () => {
    const { service } = await runReport({ status: 'running' }, undefined)
    expect(service.get).not.toHaveBeenCalled()
    expect(service.reportFrom.mock.calls[0]![2].delivery).toBe('wakeup')
  })

  it('names the patch pair when the report registration collides (upstream drift guard)', () => {
    const disposeSection = vi.fn()
    const childCtx = {
      systemPrompt: { section: vi.fn(() => disposeSection) },
      tools: {
        register: vi.fn(() => {
          throw new Error('tool "report" is already registered')
        }),
      },
    }
    const service = fakeServiceCtx({ status: 'idle' })
    let thrown: unknown
    try {
      installPrimeReport(childCtx as any, service.ctx as any)
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    // The diagnostic must name the package patch and keep the original cause.
    expect((thrown as Error).message).toContain('dsh-prime-agent/subagent-report')
    expect((thrown as Error).message).toContain('cordis.patch.yml')
    expect(((thrown as Error).cause as Error).message).toContain('already registered')
    // The prompt-guidance registration was rolled back.
    expect(disposeSection).toHaveBeenCalledTimes(1)
  })

  it('installs exactly one report tool plus its guidance and revokes both on dispose', () => {
    const child = fakeChildCtx()
    const service = fakeServiceCtx({ status: 'idle' })
    const dispose = installPrimeReport(child.childCtx as any, service.ctx as any)
    expect(child.childCtx.tools.register).toHaveBeenCalledTimes(1)
    expect(child.tool().name).toBe('report')
    expect(child.childCtx.systemPrompt.section).toHaveBeenCalledTimes(1)
    dispose()
    expect(child.disposeTool).toHaveBeenCalledTimes(1)
    expect(child.disposeSection).toHaveBeenCalledTimes(1)
  })
})
