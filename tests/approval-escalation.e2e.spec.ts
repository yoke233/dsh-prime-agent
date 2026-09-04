/**
 * Sandbox escalation acceptance through a REAL
 * escalating tool. The chain under test is genuine end to end — the `write`
 * tool from `@deepseek-ai/dsh-tool-fs` with its advertised
 * `sandbox_permissions`/`justification` protocol, the shared
 * `@deepseek-ai/dsh-sandbox` fail-closed choreography, the real
 * `SandboxedFileSystem` containment fence, and the real `SandboxPolicyService`.
 * Only the approval ANSWER is scripted: a structural stand-in on the
 * `ctx.approval` seam records every ask and returns a fixed outcome (the real
 * `ApprovalService` requires an open session turn for its audit pair, which
 * this direct-execution fixture does not own). The "no approval composed"
 * scenario mounts nothing at all, so that fail-closed path is entirely real.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

const signal = new AbortController().signal

/**
 * A probe OUTSIDE every writable root — `writableRoots` grants only the
 * policy's workspaceRoot, `/tmp`, and the platform tmpdir
 * (`dsh-sandbox/src/roots.ts:52-55`), and this test's workspace lives under
 * tmpdir — so the fence must refuse it even under an approved
 * `workspace-write` grant. If the fence ever let it through, the write would
 * surface as a loud assertion failure, and `afterEach` force-removes the probe.
 */
const OUTSIDE_PROBE = join(homedir(), 'dsh-prime-agent-escalation-denied-probe.txt')

/** One recorded approval ask: the fields the audit trail keys on. */
interface RecordedAsk {
  toolName: string
  reason: string
}

/**
 * Structural stand-in on the approval seam: `approveEscalation` consumes only
 * `request()` (`dsh-sandbox/src/escalation.ts:102-109`), so this records every
 * ask and answers with one scripted outcome.
 */
class FakeApproval extends Service {
  requests: RecordedAsk[] = []
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'

  constructor(ctx: Context) {
    super(ctx, 'approval')
  }

  request(req: { toolName: string; reason: string }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    this.requests.push({ toolName: req.toolName, reason: req.reason })
    return Promise.resolve(this.outcome)
  }
}

let ctx: Context | undefined
let root: string | undefined
let callNumber = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callNumber = 0
  await rm(OUTSIDE_PROBE, { force: true })
})

interface Booted {
  agent: Agent
  workspace: string
  approval: FakeApproval | undefined
}

/** Boot the real chain: policy → sandboxing fs backend → tool suite, plus the optional scripted approval seam. */
async function bootFs(options: { mode: 'read-only' | 'workspace-write'; approval: boolean }): Promise<Booted> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prime-escalation-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const context = new Context()
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime, {})
  await context.plugin(SandboxPolicyService, { mode: options.mode, workspaceRoot: workspace })
  await context.plugin(SandboxedFileSystem, { cwd: workspace })
  const toolFsFiber = context.plugin(ToolFs, {})
  await toolFsFiber.await()
  let approval: FakeApproval | undefined
  if (options.approval) {
    await context.plugin(FakeApproval)
    approval = context.get('approval') as unknown as FakeApproval
  }
  ctx = context
  const id = SessionId('escalation-agent')
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: workspace,
  })
  const agent = {
    id,
    session,
  } as unknown as Agent
  return { agent, workspace, approval }
}

async function write(agent: Agent, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  if (ctx === undefined) throw new Error('test context was not created')
  return await ctx.tools.execute({
    callId: ToolCallId(`escalation-${++callNumber}`),
    name: 'write',
    arguments: args,
    signal,
    agent,
  })
}

function failureMessage(execution: ToolExecutionResult): string {
  if (!execution.isError) throw new Error('expected the call to fail')
  return execution.error.message
}

describe('sandbox escalation through the real write tool', () => {
  it('never asks for permission when nothing was denied', async () => {
    const { agent, workspace, approval } = await bootFs({ mode: 'workspace-write', approval: true })
    const target = join(workspace, 'notes.txt')

    const execution = await write(agent, { file_path: target, content: 'inside the workspace' })

    expect(execution.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('inside the workspace')
    // No denial happened, so no approval ask may exist.
    expect(approval?.requests).toEqual([])
  })

  it('denies under read-only with the escalation hint, then grants one same-operation retry', async () => {
    const { agent, workspace, approval } = await bootFs({ mode: 'read-only', approval: true })
    const target = join(workspace, 'ledger.txt')

    const denied = await write(agent, { file_path: target, content: 'first attempt' })
    const deniedMessage = failureMessage(denied)
    expect(deniedMessage).toContain('[sandbox: file access denied under read-only mode]')
    expect(deniedMessage).toContain('retry this exact operation once with sandbox_permissions')
    expect(existsSync(target)).toBe(false)
    // The denial itself never prompts a human.
    expect(approval?.requests).toEqual([])

    // The sanctioned retry: SAME path, SAME content, the narrowest wider mode.
    const escalated = await write(agent, {
      file_path: target,
      content: 'first attempt',
      sandbox_permissions: 'workspace-write',
      justification: 'Write the ledger file inside the workspace.',
    })
    expect(escalated.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('first attempt')
    // Exactly one ask, carrying the mode and the verbatim justification.
    expect(approval?.requests).toEqual([{
      toolName: 'write',
      reason: 'escalate sandbox to workspace-write: Write the ledger file inside the workspace.',
    }])
  })

  it('leaves the tool body unexecuted when the user rejects the escalation', async () => {
    const { agent, workspace, approval } = await bootFs({ mode: 'read-only', approval: true })
    if (approval === undefined) throw new Error('fixture must mount the approval seam')
    approval.outcome = 'rejected'
    const target = join(workspace, 'rejected.txt')

    const execution = await write(agent, {
      file_path: target,
      content: 'never written',
      sandbox_permissions: 'workspace-write',
      justification: 'Write a file the user will refuse.',
    })

    expect(failureMessage(execution)).toContain('the user rejected escalating this operation to "workspace-write"')
    // Rejection precedes execution: the file must not exist.
    expect(existsSync(target)).toBe(false)
    expect(approval.requests).toHaveLength(1)
  })

  it('fails closed when no approval service is composed', async () => {
    const { agent, workspace } = await bootFs({ mode: 'read-only', approval: false })
    const target = join(workspace, 'unapproved.txt')

    const execution = await write(agent, {
      file_path: target,
      content: 'never written',
      sandbox_permissions: 'workspace-write',
      justification: 'Ask with nobody to answer.',
    })

    expect(failureMessage(execution)).toContain('requires approval, but no approval service is composed')
    expect(existsSync(target)).toBe(false)
  })

  it('stops after an approved escalation still fails, with no further asks', async () => {
    const { agent, approval } = await bootFs({ mode: 'read-only', approval: true })

    const execution = await write(agent, {
      file_path: OUTSIDE_PROBE,
      content: 'never written',
      sandbox_permissions: 'workspace-write',
      justification: 'Write a probe outside every writable root.',
    })

    // The grant was consumed by this one call, and the real fence still
    // refused the out-of-root target under the granted mode.
    expect(failureMessage(execution)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(existsSync(OUTSIDE_PROBE)).toBe(false)
    // Exactly one ask: no second escalation, no alternate route.
    expect(approval?.requests).toHaveLength(1)
  })
})
