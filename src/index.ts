/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { defineTool, renderToolsSdk } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerContinual } from './continual/plugin.js'
import type { HarnessLimits } from './continual/types.js'
import { registerPolicy } from './policy.js'
import { RealmIdentityStore } from './realm/identity.js'
import type {} from './realm/runtime.js'
import { createReplBindings, REPL_TOOL_NAME } from './repl/bridge.js'

export const name = 'prime-agent'
export const inject = ['tools', 'systemPrompt', 'primeRealmRuntime']

/** Current configuration surface; removed legacy state and options are not accepted. */
export interface Config {
  stateDirectory: string
  refineToolName?: string
  allowGlobalRefinement?: boolean
  requireOrchestrationTools?: boolean
  continual?: Partial<HarnessLimits>
}

/** Schemastery configuration for the control plane and secondary learning layer. */
export const Config: z<Config> = z.object({
  stateDirectory: z.string().required(),
  refineToolName: z.string().default('refine'),
  allowGlobalRefinement: z.boolean().default(false),
  requireOrchestrationTools: z.boolean().default(true),
  continual: z.object({
    maxEntriesPerScope: z.natural().min(1).default(64),
    maxEntryIdChars: z.natural().min(1).default(128),
    maxEntryTitleChars: z.natural().min(1).default(200),
    maxEntryContentChars: z.natural().min(1).default(4000),
    maxReferenceToolChars: z.natural().min(1).default(128),
    maxEvidenceItems: z.natural().min(1).default(12),
    maxEvidenceChars: z.natural().min(1).default(1000),
    maxEditsPerTransaction: z.natural().min(1).default(16),
    maxTransactions: z.natural().min(1).default(32),
    maxStateBytes: z.natural().min(1024).default(524288),
    maxPromptEntriesPerScope: z.natural().min(1).default(32),
    maxPromptCharsPerScope: z.natural().min(256).default(16000),
  }),
}) as unknown as z<Config>

const CONTINUAL_DEFAULTS: HarnessLimits = {
  maxEntriesPerScope: 64,
  maxEntryIdChars: 128,
  maxEntryTitleChars: 200,
  maxEntryContentChars: 4000,
  maxReferenceToolChars: 128,
  maxEvidenceItems: 12,
  maxEvidenceChars: 1000,
  maxEditsPerTransaction: 16,
  maxTransactions: 32,
  maxStateBytes: 524288,
  maxPromptEntriesPerScope: 32,
  maxPromptCharsPerScope: 16000,
}

function toolName(value: string | undefined, fallback: string, field: string): string {
  const resolved = (value ?? fallback).trim()
  if (!/^[a-z][a-z0-9_]*$/.test(resolved)) {
    throw new Error(`dsh-prime-agent: ${field} must match /^[a-z][a-z0-9_]*$/`)
  }
  return resolved
}

function positiveLimits<T extends object>(defaults: T, partial: Partial<T> | undefined, label: string): T {
  const limits = { ...defaults, ...partial } as T
  for (const [key, value] of Object.entries(limits as Record<string, number>)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`dsh-prime-agent: ${label}.${key} must be a positive safe integer`)
  }
  return limits
}

function sdkText(ctx: Context, agent: Agent): string {
  const schemas = ctx.tools.schemas(agent)
    .filter(schema => schema.name !== REPL_TOOL_NAME)
    .map((schema) => {
      const definition = ctx.tools.get(schema.name, agent)
      if (definition === undefined) throw new Error(`dsh-prime-agent: capability disappeared during prompt assembly: ${schema.name}`)
      return { ...schema, output: definition.output.schema }
    })
  return renderToolsSdk(schemas)
    .replace('## Writing code for run_code', '## Using the TypeScript REPL')
    .replace('`run_code` takes two required arguments: `code` — the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped) — and `description`, a short summary of what the program does. Inside the program:', 'The `repl` tool executes one persistent TypeScript cell. Top-level `await` works. Erasable TypeScript syntax is supported (no `enum` or namespaces; type annotations are advisory and run type-stripped). Inside the cell:')
    .replace('the body of an async TypeScript function', 'one persistent TypeScript REPL cell')
    .replace('- Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output.', '- The final expression is the cell result; top-level `return` is invalid. `console.log(...)` still emits logs.')
    + '\n\nConvenience aliases:\n'
    + 'declare const agents: { spawn(args: unknown): Promise<unknown>; fork(args: unknown): Promise<unknown>; list(args: unknown): Promise<unknown>; send(args: unknown): Promise<unknown>; interrupt(args: unknown): Promise<unknown> };\n'
    + 'declare const jobs: { list(args: unknown): Promise<unknown>; output(args: unknown): Promise<unknown>; kill(args: unknown): Promise<unknown> };'
}

/** Register the sole model-visible REPL and its hidden host capabilities. */
export function apply(ctx: Context, config: Config): void {
  const stateDirectory = config.stateDirectory.trim()
  if (stateDirectory.length === 0) throw new Error('dsh-prime-agent: stateDirectory must not be empty')
  const refineToolName = toolName(config.refineToolName, 'refine', 'refineToolName')
  const continualLimits = positiveLimits(CONTINUAL_DEFAULTS, config.continual, 'continual')
  const identity = new RealmIdentityStore({ directory: join(stateDirectory, 'realm-identity') })

  ctx.tools.register(defineTool({
    name: REPL_TOOL_NAME,
    description: 'Execute a TypeScript REPL cell.',
    parameters: { code: { type: 'string', required: true, description: 'TypeScript source code for this cell.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { logs: { type: 'array', required: true, items: { type: 'string' } }, result: { type: 'json' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('repl requires an owning agent session')
      let realmId: string
      try { realmId = await identity.resolve(String(exec.agent.id)) } catch { throw new Error('repl session identity is unavailable') }
      const leased = createReplBindings(ctx, exec)
      try {
        const outcome = await ctx.primeRealmRuntime.run(realmId, { program: args.code, bindings: leased.bindings, signal: exec.signal })
        if (outcome.error !== undefined) {
          const logs = outcome.logs.length === 0 ? '' : `\n${outcome.logs.join('\n')}`
          throw new Error(`repl cell failed (${outcome.error.kind}): ${outcome.error.message}${logs}`)
        }
        return { logs: outcome.logs, ...(outcome.value === undefined ? {} : { result: outcome.value }) }
      } finally { await leased.finish() }
    },
  }))

  registerPolicy(ctx, { requireOrchestrationTools: config.requireOrchestrationTools ?? true })
  registerContinual(ctx, { stateDirectory: join(stateDirectory, 'continual'), toolName: refineToolName, allowGlobal: config.allowGlobalRefinement ?? false, limits: continualLimits })

  ctx.tools.guard(exec => exec.parent === undefined && exec.name !== REPL_TOOL_NAME ? 'use the repl tool for this session' : undefined)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (context.agent === undefined) return result
    const repl = result.tools.find(tool => tool.name === REPL_TOOL_NAME)
    if (repl === undefined) throw new Error('dsh-prime-agent: repl tool is unavailable')
    result.tools = [repl]
    const text = sdkText(ctx, context.agent)
    const sdk = result.sections.find(section => section.name === 'tools:sdk')
    if (sdk === undefined) result.sections.push({ name: 'tools:sdk', text })
    else sdk.text = text
    return result
  })
}
export { HarnessStore, renderHarnessState } from './continual/store.js'
export type {
  HarnessChange,
  HarnessEdit,
  HarnessEntry,
  HarnessEntryKind,
  HarnessReference,
  HarnessScope,
  HarnessState,
  HarnessTransaction,
} from './continual/types.js'
