/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { defineTool, renderToolsSdk } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerApplyPatch } from './apply-patch/plugin.js'
import { registerContinual } from './continual/plugin.js'
import { registerRefineCommand } from './continual/command.js'
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
  allowGlobalRefinement?: boolean
  refinementMaxTokens?: number
  refinementMaxConversationChars?: number
  requireOrchestrationTools?: boolean
  continual?: Partial<HarnessLimits>
}

/** Schemastery configuration for the control plane and secondary learning layer. */
export const Config: z<Config> = z.object({
  stateDirectory: z.string().required(),
  allowGlobalRefinement: z.boolean().default(false),
  refinementMaxTokens: z.natural().min(256).default(4096),
  refinementMaxConversationChars: z.natural().min(1000).default(80000),
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

function positiveLimits<T extends object>(defaults: T, partial: Partial<T> | undefined, label: string): T {
  const limits = { ...defaults, ...partial } as T
  for (const [key, value] of Object.entries(limits as Record<string, number>)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`dsh-prime-agent: ${label}.${key} must be a positive safe integer`)
  }
  return limits
}

const REPL_AGENT_PROMPT = `## Persistent TypeScript REPL

Call only \`repl\` directly. In the TypeScript code passed to \`repl\`, use the
preloaded \`tools.*\`, \`agents.*\`, and \`jobs.*\` APIs. Follow each generated
declaration and its comments. \`import\` and \`require\` are unavailable.

Top-level \`await\` works; top-level \`return\` does not. Treat the REPL as a live
notebook: successful top-level bindings remain available in later cells. Prefer \`let\`
for named tool results and working values you may refine across cells. Before repeating
a tool call, continue from the existing binding; reassign or transform it as needed. A
parse failure executes nothing; fix the cell and retry.
Pass TypeScript object literals, writing identifier keys as \`key: 'value'\`, not
\`key': 'value'\`. Tool results are parsed JavaScript values; do not call
\`JSON.parse\` on them. Inspect uncertain shapes with \`Array.isArray(value)\` and
\`Object.keys(value)\`.

\`$_\` is the latest available non-undefined result. A later value-producing cell
replaces it, so assign reusable values to named variables before running that cell.
Continue from variables or \`$_\` instead of parsing shortened display text. A
shortened display does not shorten the value already assigned to your variable.
When a result reports \`Full formatted result stored at:\`, use that variable for
structured data or read/grep the reported locator for omitted formatted text before
repeating the same request. Convert Windows locator backslashes to forward slashes
before putting the path in a string literal. Backslashes in JSON previews are notation,
not extra characters. Prefer forward-slash Windows paths such as \`D:/work/project\`.

Keep large source material in files and only compact working state in the REPL.`

const TOOL_AGENT_GUIDANCE: Readonly<Record<string, string>> = {
  edit: 'Read the current file before editing; after a stale-file error, read it again before retrying.',
  glob: 'For directory names, use pwsh `Get-ChildItem -Directory`. Avoid a bare `*` under a broad root.',
  grep: 'A string value is still interpreted as a regular expression. For literal code search, omit punctuation when possible. When punctuation matters, use a no-flags literal `.source`, for example `pattern: /stream\\(options\\)/.source`. Run unrelated searches as separate parallel calls; simplify a rejected pattern before retrying.',
  pwsh: 'When a shell command contains single-quoted fragments, use a double-quoted TypeScript `command` value and escape any embedded double quotes.',
  write: 'Use this for file creation or complete replacement; prefer edit for targeted changes. Read an existing file before overwriting it.',
}

const TOOL_AGENT_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  todo_write: 'Track user-visible progress only for long-running plans or genuinely parallel work. Each call replaces the entire list. Keep ordinary one-turn edits, builds, tests, and installs in the live notebook without a task list. When tracking is useful, update at meaningful phase boundaries and combine status changes from the same phase. Keep at least one item in_progress while work remains; use no in_progress item once all work is complete.',
}

const COMPLETION_INTRINSICS = 'declare const $_: unknown'

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
      const override = TOOL_AGENT_DESCRIPTION_OVERRIDES[schema.name]
      const guidance = TOOL_AGENT_GUIDANCE[schema.name]
      const description = override ?? (guidance === undefined
        ? schema.description
        : `${schema.description}\n\n${guidance}`)
      return { ...schema, description, output: definition.output.schema }
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
  return `${REPL_AGENT_PROMPT}\n\nAvailable functions and values:\n\n\`\`\`ts\n${declarations.join('\n\n')}\n\`\`\``
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
      + 'Assign it to a variable before running another value-producing cell.\n'
      + `Type: ${presentation.valueType}`
      + (presentation.serializedBytes === undefined ? '' : `\nSerialized size: ${presentation.serializedBytes.toLocaleString('en-US')} bytes`)
      + previewSection(value)
  }
  if (presentation.kind === 'unretained-preview') {
    const reason = presentation.reason ?? 'the single-slot retention budget was exceeded'
    return `The complete value was not retained: ${reason}.\n`
      + 'This preview is not the original value. Recompute it or load it from a durable file.\n'
      + `Type: ${presentation.valueType}`
      + (presentation.serializedBytes === undefined ? '' : `\nSerialized size: ${presentation.serializedBytes.toLocaleString('en-US')} bytes`)
      + previewSection(value)
  }
  return 'The value remains in this REPL as `$_`.\n'
    + 'Assign it to a variable before running another value-producing cell.\n'
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
  const continualLimits = positiveLimits(CONTINUAL_DEFAULTS, config.continual, 'continual')
  const identity = new RealmIdentityStore({ directory: join(stateDirectory, 'realm-identity') })
  const allowGlobalRefinement = config.allowGlobalRefinement ?? false
  const refinementMaxTokens = config.refinementMaxTokens ?? 4096
  const refinementMaxConversationChars = config.refinementMaxConversationChars ?? 80000
  const continual = registerContinual(ctx, {
    stateDirectory: join(stateDirectory, 'continual'),
    allowGlobal: allowGlobalRefinement,
    limits: continualLimits,
    maxTokens: refinementMaxTokens,
    maxConversationChars: refinementMaxConversationChars,
  })
  registerRefineCommand(ctx, continual.store, {
    allowGlobal: allowGlobalRefinement,
    limits: continualLimits,
    maxTokens: refinementMaxTokens,
    maxConversationChars: refinementMaxConversationChars,
  })

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
      const leased = createReplBindings(ctx, exec, [continual.bindingFor(exec.agent)])
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

  registerApplyPatch(ctx)
  registerPolicy(ctx, { requireOrchestrationTools: config.requireOrchestrationTools ?? true })
  ctx.tools.guard(exec => exec.parent === undefined && exec.name !== REPL_TOOL_NAME
    ? `Call repl directly. Inside its code, invoke tools.${exec.name}(args); ${exec.name} is not directly callable in this session.`
    : undefined)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (context.agent === undefined) return result
    const repl = result.tools.find(tool => tool.name === REPL_TOOL_NAME)
    if (repl === undefined) throw new Error('dsh-prime-agent: repl tool is unavailable')
    result.tools = [repl]
    result.sections = result.sections.filter(section =>
      section.name !== 'harness:identity' && !section.name.startsWith('tool:'))
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
