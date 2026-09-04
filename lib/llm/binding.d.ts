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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CodeBindingFunction } from '@deepseek-ai/dsh-code-runtime';
/** Budgets bounding one cell's sub-model calls. */
export interface LlmBindingLimits {
    /** Maximum UTF-16 length of one prompt (system text is counted separately under the same cap). */
    maxPromptChars: number;
    /** Maximum prompts one `queryMany` call accepts. */
    maxBatchSize: number;
    /** Maximum prompts of one `queryMany` call in flight at once. */
    maxConcurrency: number;
    /** Default and upper bound for a reply's `maxTokens`. */
    maxTokens: number;
}
export declare const LLM_BINDING_DEFAULTS: LlmBindingLimits;
/** The namespace the members are installed on and the member names the program calls. */
export declare const LLM_BINDING_NAMESPACE = "agents";
export declare const LLM_QUERY_MEMBER = "query";
export declare const LLM_QUERY_MANY_MEMBER = "queryMany";
/** One reply as the program receives it. */
export interface LlmReply {
    text: string;
    /** `true` when the reply stopped at `maxTokens` rather than at a natural end. */
    truncated: boolean;
}
/** Build the leased sub-model members for one cell of `agent`, cancelled with `signal`. */
export declare function createLlmFunctions(ctx: Context, agent: Agent, limits: LlmBindingLimits, signal: AbortSignal): Record<string, CodeBindingFunction>;
/** JSDoc lines placed above the `agents` declaration that carries these members. */
export declare const LLM_NAMESPACE_DOC: readonly string[];
/** The member lines (2-space indented) the generated `agents` declaration shows for these bindings. */
export declare function renderLlmMembers(limits: LlmBindingLimits): string[];
//# sourceMappingURL=binding.d.ts.map