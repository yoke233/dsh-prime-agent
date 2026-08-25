import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executePatch } from './executor.js'
import { PatchError } from './types.js'

export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

/** Register the Realm-only composite patch capability. */
export function registerApplyPatch(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: APPLY_PATCH_TOOL_NAME,
    description: 'Apply related Add/Update file changes described by *** Begin Patch text.',
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
  }))
}
