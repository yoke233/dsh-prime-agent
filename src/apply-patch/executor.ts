import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { parsePatch } from './parser.js'
import { planPatch } from './planner.js'
import { PATCH_ERROR_CODES, PatchError, type ApplyPatchResult } from './types.js'

interface ReadLine {
  number: number
  text: string
}

interface ReadPage {
  lines: ReadLine[]
  totalLines: number
}

function readPage(value: JsonValue, path: string, expectedOffset: number): ReadPage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PatchError(PATCH_ERROR_CODES.snapshotReadFailed, `read returned an invalid snapshot for ${path}`, { path })
  }
  const lines = value.lines
  const totalLines = value.totalLines
  const offset = value.offset
  if (!Array.isArray(lines) || !Number.isInteger(totalLines) || (totalLines as number) < 0 || offset !== expectedOffset) {
    throw new PatchError(PATCH_ERROR_CODES.snapshotReadFailed, `read returned an invalid snapshot for ${path}`, { path })
  }
  const parsed: ReadLine[] = []
  let nextNumber = expectedOffset
  for (const line of lines) {
    if (typeof line !== 'object' || line === null || Array.isArray(line)
      || line.number !== nextNumber || line.number > (totalLines as number) || typeof line.text !== 'string') {
      throw new PatchError(PATCH_ERROR_CODES.snapshotReadFailed, `read returned a non-contiguous snapshot for ${path}`, { path })
    }
    if (/\.\.\. \(line truncated to \d+ chars\)$/.test(line.text)) {
      throw new PatchError(PATCH_ERROR_CODES.snapshotReadFailed, `read truncated a line in ${path}; apply_patch cannot preflight it safely`, { path })
    }
    parsed.push({ number: line.number, text: line.text })
    nextNumber += 1
  }
  return { lines: parsed, totalLines: totalLines as number }
}

function forwardNestedResult(exec: ToolRunContext, result: ToolExecutionResult): void {
  for (const context of result.additionalContexts ?? []) exec.deferContext(context)
  if (!result.isError && result.concludesTurn) exec.concludeTurn()
}

/** Execute one fully preflighted patch through the owning Agent's registered read/write tools. */
export async function executePatch(ctx: Context, args: { patch: string }, exec: ToolRunContext): Promise<ApplyPatchResult> {
  const parsed = parsePatch(args.patch)
  const agent = exec.agent
  if (agent === undefined) {
    throw new PatchError(PATCH_ERROR_CODES.capabilityUnavailable, 'apply_patch requires an owning agent session')
  }
  for (const name of ['read', 'write']) {
    if (ctx.tools.get(name, agent) === undefined) {
      throw new PatchError(PATCH_ERROR_CODES.capabilityUnavailable, `apply_patch requires the owning agent catalog capability: ${name}`)
    }
  }

  let dispatchNumber = 0
  const dispatch = async (name: 'read' | 'write', argumentsValue: unknown): Promise<ToolExecutionResult> => {
    const result = await ctx.tools.execute({
      callId: CallId(`${String(exec.callId)}:apply_patch:${++dispatchNumber}`),
      rootCallId: exec.rootCallId,
      name,
      arguments: argumentsValue,
      agent,
      parent: exec.token,
      signal: exec.signal,
    })
    forwardNestedResult(exec, result)
    return result
  }

  const snapshots = new Map<string, string | null>()
  for (const file of parsed.files) {
    const collected: string[] = []
    let offset = 1
    let totalLines: number | undefined
    while (true) {
      const result = await dispatch('read', { file_path: file.path, offset })
      if (result.isError) {
        if (result.error.info?.code === 'FS_NOT_FOUND') {
          snapshots.set(file.path, null)
          break
        }
        throw new PatchError(
          PATCH_ERROR_CODES.snapshotReadFailed,
          `could not preflight ${file.path}: ${result.error.message}`,
          { path: file.path },
        )
      }
      const page = readPage(result.value, file.path, offset)
      if (totalLines !== undefined && page.totalLines !== totalLines) {
        throw new PatchError(PATCH_ERROR_CODES.snapshotReadFailed, `file changed while reading ${file.path}`, { path: file.path })
      }
      totalLines = page.totalLines
      collected.push(...page.lines.map(line => line.text))
      const nextOffset = offset + page.lines.length
      if (nextOffset > page.totalLines) {
        snapshots.set(file.path, collected.length === 0 ? '' : `${collected.join('\n')}\n`)
        break
      }
      if (page.lines.length === 0) {
        throw new PatchError(PATCH_ERROR_CODES.snapshotReadFailed, `read could not return a complete snapshot for ${file.path}`, { path: file.path })
      }
      offset = nextOffset
    }
  }

  const plan = planPatch(parsed, snapshots)
  const applied: ApplyPatchResult['files'] = []
  for (const file of plan.files) {
    const result = await dispatch('write', { file_path: file.path, content: file.content })
    if (result.isError) {
      const paths = applied.map(item => item.path).join(', ')
      const code = applied.length === 0 ? PATCH_ERROR_CODES.mutationFailed : PATCH_ERROR_CODES.partialApply
      const prefix = applied.length === 0
        ? `failed to write ${file.path}`
        : `patch partially applied; wrote ${paths} before ${file.path} failed`
      throw new PatchError(code, `${prefix}: ${result.error.message}`, { path: file.path })
    }
    applied.push({ path: file.path, operation: file.operation, hunks: file.hunks })
  }
  return { applied: true, files: applied }
}
