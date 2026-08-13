/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerContinual } from './continual/plugin.js'
import type { HarnessLimits } from './continual/types.js'
import { registerRlm } from './rlm/plugin.js'
import type { ContextLimits } from './rlm/types.js'

export const name = 'prime-agent'
export const inject = ['tools', 'systemPrompt']

/** Clean v0.2 configuration; no v0.1 state or option compatibility is retained. */
export interface Config {
  stateDirectory: string
  contextToolName?: string
  refineToolName?: string
  allowGlobalContext?: boolean
  allowGlobalRefinement?: boolean
  requireCodeMode?: boolean
  requireOrchestrationTools?: boolean
  context?: Partial<ContextLimits>
  continual?: Partial<HarnessLimits>
}

/** Schemastery configuration for the RLM workspace and secondary learning layer. */
export const Config: z<Config> = z.object({
  stateDirectory: z.string().required(),
  contextToolName: z.string().default('prime_context'),
  refineToolName: z.string().default('prime_refine'),
  allowGlobalContext: z.boolean().default(false),
  allowGlobalRefinement: z.boolean().default(false),
  requireCodeMode: z.boolean().default(true),
  requireOrchestrationTools: z.boolean().default(true),
  context: z.object({
    maxEntriesPerScope: z.natural().min(1).default(128),
    maxKeyChars: z.natural().min(1).default(160),
    maxSummaryChars: z.natural().min(1).default(500),
    maxValueBytes: z.natural().min(1).default(16 * 1024 * 1024),
    maxTotalBytesPerScope: z.natural().min(1).default(256 * 1024 * 1024),
    maxManifestBytes: z.natural().min(1024).default(2 * 1024 * 1024),
    maxReadChars: z.natural().min(1).default(32_000),
    maxSearchQueryChars: z.natural().min(1).default(500),
    maxSearchMatches: z.natural().min(1).default(50),
    maxSearchWindowChars: z.natural().min(1).default(500),
    maxSearchChars: z.natural().min(1).default(2_000_000),
    maxCatalogEntries: z.natural().min(1).default(64),
    maxCatalogChars: z.natural().min(256).default(12_000),
  }),
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

const CONTEXT_DEFAULTS: ContextLimits = {
  maxEntriesPerScope: 128,
  maxKeyChars: 160,
  maxSummaryChars: 500,
  maxValueBytes: 16 * 1024 * 1024,
  maxTotalBytesPerScope: 256 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxReadChars: 32_000,
  maxSearchQueryChars: 500,
  maxSearchMatches: 50,
  maxSearchWindowChars: 500,
  maxSearchChars: 2_000_000,
  maxCatalogEntries: 64,
  maxCatalogChars: 12_000,
}

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

/** Register the RLM workspace, learning layer, and strict Code Mode assembly invariant. */
export function apply(ctx: Context, config: Config): void {
  const stateDirectory = config.stateDirectory.trim()
  if (stateDirectory.length === 0) throw new Error('dsh-prime-agent: stateDirectory must not be empty')
  const contextToolName = toolName(config.contextToolName, 'prime_context', 'contextToolName')
  const refineToolName = toolName(config.refineToolName, 'prime_refine', 'refineToolName')
  if (contextToolName === refineToolName) throw new Error('dsh-prime-agent: contextToolName and refineToolName must differ')
  const contextLimits = positiveLimits(CONTEXT_DEFAULTS, config.context, 'context')
  const continualLimits = positiveLimits(CONTINUAL_DEFAULTS, config.continual, 'continual')

  registerRlm(ctx, {
    stateDirectory: join(stateDirectory, 'rlm'),
    toolName: contextToolName,
    allowGlobal: config.allowGlobalContext ?? false,
    requireOrchestrationTools: config.requireOrchestrationTools ?? true,
    limits: contextLimits,
  })
  registerContinual(ctx, {
    stateDirectory: join(stateDirectory, 'continual'),
    toolName: refineToolName,
    contextToolName,
    allowGlobal: config.allowGlobalRefinement ?? false,
    limits: continualLimits,
  })

  if (config.requireCodeMode ?? true) {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (context.agent === undefined) return result
      if (result.tools.length !== 1 || result.tools[0]?.name !== RUN_CODE_NAME) {
        throw new Error(`dsh-prime-agent: agent ${String(context.agent.id)} must use Code Mode; expected the sole model-visible tool to be ${RUN_CODE_NAME}`)
      }
      return result
    })
  }
}

export { HarnessStore, renderHarnessState } from './continual/store.js'
export { ContextStore, renderContextCatalog } from './rlm/store.js'
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
export type {
  ArtifactReference,
  ContextEntry,
  ContextLimits,
  ContextManifest,
  ContextRead,
  ContextScope,
  ContextSearchMatch,
  ContextSearchResult,
  ContextValueKind,
} from './rlm/types.js'
