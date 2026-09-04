/**
 * Stateless sub-model calls for the persistent REPL: `agents.query` and
 * `agents.queryMany` let a cell ask the Agent's own route about text it already
 * holds in variables (summarize a chunk, classify, extract) without that text
 * entering the conversation. They are private Realm bindings, not DSH tools:
 * never under `tools.*`, not directly callable, and they create no dispatch log
 * rows. They live inside the existing `agents` namespace on purpose: adding a
 * fifth injected global has crashed worker teardown (see `docs/architecture.md`).
 * @module dsh-prime-agent/llm/binding
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CodeBindingFunction, CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'
import { BlockAssembler, createUserMessage, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { modelTarget } from '../continual/command.js'

/** Budgets bounding one cell's sub-model calls. */
export interface LlmBindingLimits {
  /** Maximum UTF-16 length of one prompt (system text is counted separately under the same cap). */
  maxPromptChars: number
  /** Maximum prompts one `queryMany` call accepts. */
  maxBatchSize: number
  /** Maximum prompts of one `queryMany` call in flight at once. */
  maxConcurrency: number
  /** Default and upper bound for a reply's `maxTokens`. */
  maxTokens: number
}

export const LLM_BINDING_DEFAULTS: LlmBindingLimits = {
  maxPromptChars: 200000,
  maxBatchSize: 20,
  maxConcurrency: 8,
  maxTokens: 4096,
}

/** The namespace the members are installed on and the member names the program calls. */
export const LLM_BINDING_NAMESPACE = 'agents'
export const LLM_QUERY_MEMBER = 'query'
export const LLM_QUERY_MANY_MEMBER = 'queryMany'

const QUERY = `${LLM_BINDING_NAMESPACE}.${LLM_QUERY_MEMBER}`
const QUERY_MANY = `${LLM_BINDING_NAMESPACE}.${LLM_QUERY_MANY_MEMBER}`

interface QueryRequest {
  prompt: string
  system?: string
  /** Always resolved by parsing: the caller's value capped at the limit, else the limit. */
  maxTokens: number
}

interface BatchRequest {
  prompts: string[]
  system?: string
  maxTokens: number
}

/** One reply as the program receives it. */
export interface LlmReply {
  text: string
  /** `true` when the reply stopped at `maxTokens` rather than at a natural end. */
  truncated: boolean
}

function record(value: unknown, member: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${member}() takes one object argument`)
  }
  return value as Record<string, unknown>
}

function optionalText(value: unknown, member: string, field: string, limit: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${member}() ${field} must be a string`)
  if (value.length > limit) throw new Error(`${member}() ${field} is ${value.length} characters; the limit is ${limit}. Slice or split it first`)
  return value
}

function requiredText(value: unknown, member: string, field: string, limit: number): string {
  const text = optionalText(value, member, field, limit)
  if (text === undefined || text.trim().length === 0) throw new Error(`${member}() ${field} must be a non-empty string`)
  return text
}

function maxTokensOf(value: unknown, member: string, limit: number): number {
  if (value === undefined) return limit
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${member}() maxTokens must be a positive integer`)
  return Math.min(value as number, limit)
}

function rejectUnknownKeys(args: Record<string, unknown>, member: string, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`${member}() received unknown argument ${JSON.stringify(key)}`)
  }
}

function parseQuery(value: unknown, limits: LlmBindingLimits): QueryRequest {
  const args = record(value, QUERY)
  rejectUnknownKeys(args, QUERY, ['prompt', 'system', 'maxTokens'])
  const system = optionalText(args.system, QUERY, 'system', limits.maxPromptChars)
  return {
    prompt: requiredText(args.prompt, QUERY, 'prompt', limits.maxPromptChars),
    ...(system === undefined ? {} : { system }),
    maxTokens: maxTokensOf(args.maxTokens, QUERY, limits.maxTokens),
  }
}

function parseBatch(value: unknown, limits: LlmBindingLimits): BatchRequest {
  const args = record(value, QUERY_MANY)
  rejectUnknownKeys(args, QUERY_MANY, ['prompts', 'system', 'maxTokens'])
  if (!Array.isArray(args.prompts) || args.prompts.length === 0) throw new Error(`${QUERY_MANY}() prompts must be a non-empty array`)
  if (args.prompts.length > limits.maxBatchSize) {
    throw new Error(`${QUERY_MANY}() received ${args.prompts.length} prompts; the limit is ${limits.maxBatchSize}. Merge small prompts or call it again for the rest`)
  }
  const prompts = args.prompts.map((prompt, index) => requiredText(prompt, QUERY_MANY, `prompts[${index}]`, limits.maxPromptChars))
  const system = optionalText(args.system, QUERY_MANY, 'system', limits.maxPromptChars)
  return {
    prompts,
    ...(system === undefined ? {} : { system }),
    maxTokens: maxTokensOf(args.maxTokens, QUERY_MANY, limits.maxTokens),
  }
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function generate(ctx: Context, agent: Agent, request: QueryRequest, signal: AbortSignal): Promise<LlmReply> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('the LLM service is unavailable in this session')
  const target = modelTarget(agent)
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: request.prompt }], source: { kind: 'plugin', plugin: 'dsh-prime-agent' } })],
    ...(request.system === undefined ? {} : { system: request.system }),
    maxTokens: request.maxTokens,
    sessionId: agent.session.id,
    signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`model call failed: ${finish.failure.message}`)
  if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') throw new Error(`model call stopped unexpectedly: ${finish.kind}`)
  return { text: textOf(assembler.blocks()), truncated: finish.kind === 'max-tokens' }
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await operation(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/** Build the leased sub-model members for one cell of `agent`, cancelled with `signal`. */
export function createLlmFunctions(ctx: Context, agent: Agent, limits: LlmBindingLimits, signal: AbortSignal): Record<string, CodeBindingFunction> {
  return {
    [LLM_QUERY_MEMBER]: async value => await generate(ctx, agent, parseQuery(value, limits), signal) as unknown as CodeJsonValue,
    [LLM_QUERY_MANY_MEMBER]: async (value) => {
      const request = parseBatch(value, limits)
      const replies = await mapBounded(request.prompts, limits.maxConcurrency, async (prompt, index) => {
        try {
          return await generate(ctx, agent, {
            prompt,
            ...(request.system === undefined ? {} : { system: request.system }),
            maxTokens: request.maxTokens,
          }, signal)
        } catch (error) {
          throw new Error(`prompts[${index}]: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      return { replies } as unknown as CodeJsonValue
    },
  }
}

/** JSDoc lines placed above the `agents` declaration that carries these members. */
export const LLM_NAMESPACE_DOC: readonly string[] = [
  '/**',
  ' * `query` and `queryMany` are stateless model calls on text already in the REPL: summarize, classify, extract from, or compare',
  ' * chunks you hold in variables. String matching finds WHERE things are; a query understands WHAT things mean. Each call sees',
  ' * only its own prompt and system text, and its reply enters the conversation only if you display it. Prefer a few substantial',
  ' * prompts over many tiny ones. Use `spawn` instead when the subtask needs tools or several steps.',
  ' */',
]

/** The member lines (2-space indented) the generated `agents` declaration shows for these bindings. */
export function renderLlmMembers(limits: LlmBindingLimits): string[] {
  return [
    `  /** One prompt, one reply. \`prompt\` and \`system\` are each capped at ${limits.maxPromptChars.toLocaleString('en-US')} characters; \`maxTokens\` defaults to and is capped at ${limits.maxTokens.toLocaleString('en-US')}. */`,
    `  ${LLM_QUERY_MEMBER}: (args: { prompt: string; system?: string; maxTokens?: number }) => Promise<{ text: string; truncated: boolean }>;`,
    `  /** Up to ${limits.maxBatchSize} prompts answered concurrently under one optional \`system\`; \`replies\` keeps the input order. */`,
    `  ${LLM_QUERY_MANY_MEMBER}: (args: { prompts: string[]; system?: string; maxTokens?: number }) => Promise<{ replies: { text: string; truncated: boolean }[] }>;`,
  ]
}
