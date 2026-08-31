import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  defineTool,
  type DiffCallView,
  type DiffResultView,
  type FileDiff,
  type ToolResult,
} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { executePatch } from './executor.js'
import { parsePatch } from './parser.js'
import { PatchError, type ParsedPatch } from './types.js'

export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

function parsedDiffs(parsed: ParsedPatch): FileDiff[] | undefined {
  const diffs: FileDiff[] = []
  for (const file of parsed.files) {
    if (file.operation === 'delete' || (file.operation === 'update' && file.movePath !== null)) return undefined
    if (file.operation === 'add') {
      diffs.push({
        path: file.path,
        oldText: null,
        newText: file.lines.length === 0 ? '' : `${file.lines.join('\n')}\n`,
      })
      continue
    }
    for (const hunk of file.hunks) {
      diffs.push({
        path: file.path,
        oldText: hunk.oldLines.length === 0 ? null : hunk.oldLines.join('\n'),
        newText: hunk.newLines.join('\n'),
      })
    }
  }
  return diffs.length === 0 ? undefined : diffs
}

function patchDiffs(patch: string): FileDiff[] | undefined {
  try {
    return parsedDiffs(parsePatch(patch))
  } catch {
    return undefined
  }
}

function metaDiffs(meta: JsonValue | undefined): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || !Array.isArray(meta.diffs)) return undefined
  const diffs: FileDiff[] = []
  for (const candidate of meta.diffs) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
    if (typeof candidate.path !== 'string'
      || (candidate.oldText !== null && typeof candidate.oldText !== 'string')
      || typeof candidate.newText !== 'string') return undefined
    diffs.push({
      path: candidate.path,
      oldText: candidate.oldText as string | null,
      newText: candidate.newText,
    })
  }
  return diffs.length === 0 ? undefined : diffs
}

function locations(diffs: readonly FileDiff[]): { path: string }[] {
  return [...new Set(diffs.map(diff => diff.path))].map(path => ({ path }))
}

/** Register the Realm-only composite patch capability. */
export function registerApplyPatch(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: APPLY_PATCH_TOOL_NAME,
    description: 'Apply related Add/Update file changes described by *** Begin Patch text. If patch content contains backticks, ${...}, or backslashes, do not embed it directly in a template literal; prefer edit for exact replacements, split the patch, or construct the string safely.',
    parameters: {
      patch: {
        type: 'string',
        required: true,
        description: 'Patch text beginning with *** Begin Patch.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean', const: true, required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                operation: { type: 'string', enum: ['add', 'update'], required: true },
                hunks: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Applied patch to ${value.files.length} file${value.files.length === 1 ? '' : 's'}.`,
      }],
      presentationMeta: args => ({
        diffs: (patchDiffs(args.patch) ?? [])
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args, exec) {
      try {
        return await executePatch(ctx, args, exec)
      } catch (error) {
        if (error instanceof PatchError) {
          const location = [
            error.path === undefined ? undefined : `path ${JSON.stringify(error.path)}`,
            error.line === undefined ? undefined : `patch line ${error.line}`,
          ].filter((part): part is string => part !== undefined).join(', ')
          throw new HarnessError(location === '' ? error.message : `${error.message} (${location})`, error.code)
        }
        throw error
      }
    },
    presentCall(args): DiffCallView | undefined {
      const diffs = patchDiffs(args.patch)
      if (diffs === undefined) return undefined
      return {
        card: 'diff',
        title: 'Apply patch',
        diffs,
        locations: locations(diffs),
      }
    },
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = metaDiffs(result.meta) ?? patchDiffs(args.patch)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: 'Apply patch', diffs }
    },
  }))
}
