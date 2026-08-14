/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerContinual } from './continual/plugin.js'
import type { HarnessLimits } from './continual/types.js'
import { registerPolicy } from './policy.js'
import { registerRealmIdentity } from './realm/identity-tool.js'

export const name = 'prime-agent'
export const inject = ['tools', 'systemPrompt']

/** Clean v0.2 configuration; no v0.1 state or option compatibility is retained. */
export interface Config {
  stateDirectory: string
  refineToolName?: string
  allowGlobalRefinement?: boolean
  requireCodeMode?: boolean
  requireOrchestrationTools?: boolean
  continual?: Partial<HarnessLimits>
}

/** Schemastery configuration for the control plane and secondary learning layer. */
export const Config: z<Config> = z.object({
  stateDirectory: z.string().required(),
  refineToolName: z.string().default('prime_refine'),
  allowGlobalRefinement: z.boolean().default(false),
  requireCodeMode: z.boolean().default(true),
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

/** Register the control-plane policy, learning layer, and strict Code Mode assembly invariant. */
export function apply(ctx: Context, config: Config): void {
  const stateDirectory = config.stateDirectory.trim()
  if (stateDirectory.length === 0) throw new Error('dsh-prime-agent: stateDirectory must not be empty')
  const refineToolName = toolName(config.refineToolName, 'prime_refine', 'refineToolName')
  const continualLimits = positiveLimits(CONTINUAL_DEFAULTS, config.continual, 'continual')

  registerPolicy(ctx, { requireOrchestrationTools: config.requireOrchestrationTools ?? true })
  registerContinual(ctx, {
    stateDirectory: join(stateDirectory, 'continual'),
    toolName: refineToolName,
    allowGlobal: config.allowGlobalRefinement ?? false,
    limits: continualLimits,
  })
  registerRealmIdentity(ctx, { stateDirectory })

  if (config.requireCodeMode ?? true) {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (context.agent === undefined) return result
      if (result.tools.length !== 1 || result.tools[0]?.name !== RUN_CODE_NAME) {
        // The agent id is deliberately absent: it is the session identifier the
        // realm protocol treats as sensitive, and a prompt-assembly failure is
        // not worth putting it into a host log.
        throw new Error(`dsh-prime-agent: this agent must use Code Mode; expected the sole model-visible tool to be ${RUN_CODE_NAME}`)
      }
      return result
    })
  }
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
