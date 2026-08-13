import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ContextStore, renderContextCatalog } from './store.js'
import type { ContextLimits, ContextPutValue, ContextScope, ContextValueKind } from './types.js'

/** RLM workspace registration configuration resolved by the root plugin. */
export interface RlmConfig {
  stateDirectory: string
  toolName: string
  allowGlobal: boolean
  requireOrchestrationTools: boolean
  limits: ContextLimits
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: { type: 'string', required: true, enum: ['catalog', 'put', 'get', 'search', 'delete'] },
    scope: { type: 'string', required: true, enum: ['local', 'global'] },
    revision: { type: 'integer', required: true },
    result: { type: 'json', required: true },
  },
} as const

function ownerFor(scope: ContextScope, agent: Agent | undefined, allowGlobal: boolean): string {
  if (scope === 'global') {
    if (!allowGlobal) throw new Error('prime-context: global workspace access is disabled by deployment policy')
    return 'global'
  }
  if (agent === undefined) throw new Error('prime-context: local workspace operations require an owning agent session')
  return String(agent.id)
}

function assertOnly(args: Record<string, unknown>, operation: string, allowed: readonly string[]): void {
  const accepted = new Set(['operation', 'scope', ...allowed])
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !accepted.has(key))
  if (unexpected.length > 0) {
    throw new Error(`prime-context: ${operation} does not accept ${unexpected.join(', ')}`)
  }
}

function orchestrationPolicy(ctx: Context, agent: Agent | undefined, toolName: string, requireTools: boolean): string {
  const subagentNames = ['subagent', 'subagent_fork'].filter(name => ctx.tools.get(name, agent) !== undefined)
  const jobNames = ['job_output', 'job_list', 'job_kill'].filter(name => ctx.tools.get(name, agent) !== undefined)
  if (requireTools && agent !== undefined && (subagentNames.length === 0 || !jobNames.includes('job_output'))) {
    const missing = [subagentNames.length === 0 ? 'subagent or subagent_fork' : '', !jobNames.includes('job_output') ? 'job_output' : '']
      .filter(Boolean).join(', ')
    throw new Error(`dsh-prime-agent: RLM orchestration requires visible ${missing}; use a DSH preset that composes delegation and jobs`)
  }
  const subagents = subagentNames.join(', ') || '(not composed)'
  const jobs = jobNames.join(', ') || '(not composed)'
  return `Prime RLM control-plane policy:
- Use Code Mode as the control plane. Compose independent reads and tool/subagent calls in one program; use Promise.all for genuine foreground parallelism.
- ${toolName} is the persistent variable namespace. Start with catalog, retrieve only needed ranges/pointers/search windows, and put reusable intermediate results back with a concise summary.
- The dynamic workspace catalog contains metadata only. Never infer a value's content from its summary; call ${toolName} get or search.
- Large task data and intermediate outputs belong in ${toolName}, not in continual learning entries or the system prompt.
- Visible delegation tools: ${subagents}. Visible job controls: ${jobs}.
- For admission-first work, use a visible subagent tool's background option, retain its returned job handle, continue other work, and collect with job_output. DSH owns cancellation, delivery, and lifecycle.
- Continual refinement is secondary: update it only for repeated failures, user corrections, or stable reusable routing lessons.`
}

/** Register the persistent RLM workspace tool and its metadata-only prompt catalog. */
export function registerRlm(ctx: Context, config: RlmConfig): ContextStore {
  const store = new ContextStore(config.stateDirectory, config.limits)
  ctx.systemPrompt.section({
    name: 'prime-agent:rlm-policy',
    order: 110,
    text: assembly => orchestrationPolicy(ctx, assembly.agent, config.toolName, config.requireOrchestrationTools),
  })
  ctx.systemPrompt.context({
    name: 'prime-agent:workspace-catalog',
    order: 40,
    text: (assembly) => {
      if (assembly.agent === undefined) return ''
      const local = store.readManifestSync('local', String(assembly.agent.id))
      const catalogs = [renderContextCatalog(local, config.limits)]
      if (config.allowGlobal) catalogs.unshift(renderContextCatalog(store.readManifestSync('global', 'global'), config.limits))
      return `Prime RLM persistent workspace catalog (metadata only; retrieve values with ${config.toolName}):\n${catalogs.join('\n\n')}`
    },
  })

  ctx.tools.register(defineTool({
    name: config.toolName,
    description: 'Persistent RLM context workspace. Catalog metadata, store values, read bounded ranges or JSON Pointers, search bounded windows, and delete by optimistic revision. Local scope belongs to the calling agent session.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['catalog', 'put', 'get', 'search', 'delete'] },
      scope: { type: 'string', enum: ['local', 'global'], default: 'local' },
      expected_revision: { type: 'integer', description: 'Required for put/delete; use the current catalog revision.' },
      key: { type: 'string', description: 'Workspace variable key.' },
      kind: { type: 'string', enum: ['text', 'json', 'artifact'], description: 'Required for put.' },
      summary: { type: 'string', description: 'Required for put; metadata only, never a substitute for the value.' },
      value: { type: 'json', description: 'Required for put. Text requires a string; artifact requires {uri, mediaType?, description?}.' },
      offset: { type: 'integer', description: 'Character offset for bounded text or serialized-JSON reads.' },
      limit: { type: 'integer', description: 'Catalog page size, read size, or search result count depending on operation.' },
      pointer: { type: 'string', description: 'RFC 6901 JSON Pointer for get; mutually exclusive with offset/limit.' },
      cursor: { type: 'integer', description: 'Zero-based catalog entry cursor.' },
      query: { type: 'string', description: 'Literal search query.' },
      case_sensitive: { type: 'boolean', description: 'Search case sensitivity; defaults false.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({
        plugin: 'dsh-prime-agent',
        schemaVersion: 2,
        operation: value.operation,
        scope: value.scope,
        revision: value.revision,
      }),
    },
    async execute(args, exec) {
      const scope = (args.scope ?? 'local') as ContextScope
      const owner = ownerFor(scope, exec.agent, config.allowGlobal)
      if (args.operation === 'catalog') {
        assertOnly(args, 'catalog', ['cursor', 'limit'])
        const manifest = await store.readManifest(scope, owner)
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? config.limits.maxCatalogEntries
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > manifest.entries.length) {
          throw new Error('prime-context: catalog cursor is outside the entry range')
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.limits.maxCatalogEntries) {
          throw new Error(`prime-context: catalog limit must be between 1 and ${config.limits.maxCatalogEntries}`)
        }
        const entries = manifest.entries.slice(cursor, cursor + limit)
        const nextCursor = cursor + entries.length
        return {
          operation: 'catalog' as const,
          scope,
          revision: manifest.revision,
          result: {
            entries,
            total_entries: manifest.entries.length,
            total_bytes: manifest.totalBytes,
            ...(nextCursor < manifest.entries.length ? { next_cursor: nextCursor } : {}),
          } as unknown as JsonValue,
        }
      }
      if (args.operation === 'put') {
        assertOnly(args, 'put', ['expected_revision', 'key', 'kind', 'summary', 'value'])
        if (args.expected_revision === undefined || args.key === undefined || args.kind === undefined
          || args.summary === undefined || args.value === undefined) {
          throw new Error('prime-context: put requires expected_revision, key, kind, summary, and value')
        }
        const { manifest, entry } = await store.put(
          scope,
          owner,
          args.expected_revision,
          args.key,
          args.kind as ContextValueKind,
          args.summary,
          args.value as ContextPutValue,
        )
        return { operation: 'put' as const, scope, revision: manifest.revision, result: { entry } as unknown as JsonValue }
      }
      if (args.operation === 'get') {
        assertOnly(args, 'get', ['key', 'offset', 'limit', 'pointer'])
        if (args.key === undefined) throw new Error('prime-context: get requires key')
        const read = await store.get(scope, owner, args.key, {
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.pointer === undefined ? {} : { pointer: args.pointer }),
        })
        return { operation: 'get' as const, scope, revision: read.manifestRevision, result: read as unknown as JsonValue }
      }
      if (args.operation === 'search') {
        assertOnly(args, 'search', ['query', 'key', 'case_sensitive', 'limit'])
        if (args.query === undefined) throw new Error('prime-context: search requires query')
        const result = await store.search(scope, owner, args.query, {
          ...(args.key === undefined ? {} : { key: args.key }),
          ...(args.case_sensitive === undefined ? {} : { caseSensitive: args.case_sensitive }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        })
        return { operation: 'search' as const, scope, revision: result.manifestRevision, result: result as unknown as JsonValue }
      }
      assertOnly(args, 'delete', ['expected_revision', 'key'])
      if (args.expected_revision === undefined || args.key === undefined) {
        throw new Error('prime-context: delete requires expected_revision and key')
      }
      const { manifest, deleted } = await store.delete(scope, owner, args.expected_revision, args.key)
      return { operation: 'delete' as const, scope, revision: manifest.revision, result: { deleted } as unknown as JsonValue }
    },
  }))
  return store
}
