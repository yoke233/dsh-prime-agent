/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { defineTool, renderToolsSdk, type JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerContinual } from './continual/plugin.js'
import type { HarnessLimits } from './continual/types.js'
import { registerPolicy } from './policy.js'
import { RealmIdentityStore } from './realm/identity.js'
import type { ReplPresentation } from './realm/protocol.js'
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

const REPL_AGENT_PROMPT = `## Persistent TypeScript REPL

Use \`repl\` to execute TypeScript cells. Top-level \`await\` works. Variables,
functions, and objects remain available in later cells while the
current REPL generation is alive. The final expression is the cell result;
top-level \`return\` is invalid.

Call the generated capabilities through \`tools.*\`, \`agents.*\`, and \`jobs.*\`.
Their results are already parsed JavaScript values. Use the generated return
types directly; do not call \`JSON.parse\` on tool results and do not guess their
fields. Assign values that you will use again. If a value's shape is uncertain,
inspect it with \`Array.isArray(value)\` and \`Object.keys(value)\`.

The latest retained cell result is available as \`$_\`. Retrieve an older retained
result with \`$out(id)\`. \`$out\` is a function, so call \`$out(id)\`; do not use
\`$out.property\` or \`$out[id]\`.

Displayed cell output may be a shortened preview. Continue computation from
your variables, \`$_\`, or \`$out(id)\` instead of parsing or copying the displayed
text. Backslashes shown inside a JSON preview are JSON notation, not additional
characters in the underlying string. When writing Windows paths yourself,
prefer forward slashes such as \`D:/work/project\`.

Keep large source material in files. Keep only paths, compact indexes, helper
functions, and task-relevant summaries in the live REPL.`

const COMPLETION_INTRINSICS = `declare const $_: unknown

declare function $out(id: number): unknown

declare namespace $out {
  function list(): Array<{
    id: number
    type: string
    bytes?: number
    nodes?: number
    opaque?: boolean
  }>
  function drop(id: number): boolean
  function clear(): void
}`

interface CapabilityAlias {
  member: string
  target: string
}

function namespaceDeclaration(global: string, aliases: CapabilityAlias[]): string | undefined {
  if (aliases.length === 0) return undefined
  const members = aliases.map(({ member, target }) =>
    `  ${member}: (args: ToolArgsMap[${JSON.stringify(target)}]) => Promise<ToolOutputMap[${JSON.stringify(target)}]>;`)
  return `declare const ${global}: {\n${members.join('\n')}\n}`
}

function sdkText(ctx: Context, agent: Agent): string {
  const schemas = ctx.tools.schemas(agent)
    .filter(schema => schema.name !== REPL_TOOL_NAME)
    .map((schema) => {
      const definition = ctx.tools.get(schema.name, agent)
      if (definition === undefined) throw new Error(`dsh-prime-agent: capability disappeared during prompt assembly: ${schema.name}`)
      return { ...schema, output: definition.output.schema }
    })
  const available = new Set(schemas.map(schema => schema.name))
  const agents = [
    available.has('subagent')
      ? { member: 'spawn', target: 'subagent' }
      : available.has('subagent_fork') ? { member: 'spawn', target: 'subagent_fork' } : undefined,
    available.has('subagent_fork') ? { member: 'fork', target: 'subagent_fork' } : undefined,
    available.has('list_agents') ? { member: 'list', target: 'list_agents' } : undefined,
    available.has('send_message') ? { member: 'send', target: 'send_message' } : undefined,
    available.has('interrupt_agent') ? { member: 'interrupt', target: 'interrupt_agent' } : undefined,
  ].filter((alias): alias is CapabilityAlias => alias !== undefined)
  const jobs = [
    available.has('job_list') ? { member: 'list', target: 'job_list' } : undefined,
    available.has('job_output') ? { member: 'output', target: 'job_output' } : undefined,
    available.has('job_kill') ? { member: 'kill', target: 'job_kill' } : undefined,
  ].filter((alias): alias is CapabilityAlias => alias !== undefined)
  const rendered = renderToolsSdk(schemas)
  const declarationStart = rendered.indexOf('```ts\n')
  const declarationEnd = rendered.lastIndexOf('\n```')
  if (declarationStart < 0 || declarationEnd < declarationStart) {
    throw new Error('dsh-prime-agent: generated tools SDK has an unsupported shape')
  }
  const declarations = [
    rendered.slice(declarationStart + '```ts\n'.length, declarationEnd),
    COMPLETION_INTRINSICS,
    namespaceDeclaration('agents', agents),
    namespaceDeclaration('jobs', jobs),
  ].filter((section): section is string => section !== undefined)
  return `${REPL_AGENT_PROMPT}\n\nThe available capabilities:\n\n\`\`\`ts\n${declarations.join('\n\n')}\n\`\`\``
}

export interface ReplExecutionResult {
  logs: string[]
  result?: JsonValue
  presentation?: ReplPresentation
}


function projectionFrom(value: JsonValue | undefined): JsonValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('projection' in value)) return undefined
  return value.projection
}

function previewSection(value: JsonValue | undefined): string {
  const projection = projectionFrom(value)
  return projection === undefined ? '' : `\n\nPreview:\n${JSON.stringify(projection, null, 2)}`
}

function renderResult(value: JsonValue | undefined, presentation: ReplPresentation | undefined): string | undefined {
  if (value === undefined) return undefined
  if (presentation === undefined || presentation.kind === 'full') {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }
  if (presentation.kind === 'retained-preview') {
    return 'The complete value remains in this REPL as `$_`.\n'
      + `For older access, use \`$out(${String(presentation.handle)})\`.\n`
      + `Type: ${presentation.valueType}`
      + (presentation.serializedBytes === undefined ? '' : `\nSerialized size: ${presentation.serializedBytes.toLocaleString('en-US')} bytes`)
      + previewSection(value)
  }
  if (presentation.kind === 'unretained-preview') {
    const reason = presentation.reason ?? 'the completion history budget was exceeded'
    return `The complete value was not retained: ${reason}.\n`
      + 'This preview is not the original value. Recompute it or load it from a durable file.\n'
      + `Type: ${presentation.valueType}`
      + (presentation.serializedBytes === undefined ? '' : `\nSerialized size: ${presentation.serializedBytes.toLocaleString('en-US')} bytes`)
      + previewSection(value)
  }
  return 'The value remains in this REPL as `$_`.\n'
    + `For older access, use \`$out(${String(presentation.handle)})\`.\n`
    + `Type: ${presentation.valueType}\n`
    + 'No structural preview is available.'
}

/** Render a canonical REPL result as notebook-style model text without changing its programmatic value. */
export function renderReplResult(value: ReplExecutionResult): string {
  const sections: string[] = []
  if (value.logs.length > 0) sections.push(value.logs.join('\n'))
  const result = renderResult(value.result, value.presentation)
  if (result !== undefined) sections.push(result)
  return sections.join('\n\n')
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
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
          presentation: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: { kind: { type: 'string', const: 'full', required: true } },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', const: 'retained-preview', required: true },
                  valueType: { type: 'string', required: true },
                  serializedBytes: { type: 'integer' },
                  handle: { type: 'integer', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', const: 'unretained-preview', required: true },
                  valueType: { type: 'string', required: true },
                  serializedBytes: { type: 'integer' },
                  reason: { type: 'string' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', const: 'opaque-reference', required: true },
                  valueType: { type: 'string', required: true },
                  handle: { type: 'integer', required: true },
                },
              },
            ],
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReplResult(value as ReplExecutionResult) }],
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
        return {
          logs: outcome.logs,
          ...(outcome.value === undefined ? {} : { result: outcome.value }),
          ...(outcome.presentation === undefined ? {} : { presentation: outcome.presentation }),
        }
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
