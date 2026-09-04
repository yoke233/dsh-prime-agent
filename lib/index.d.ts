/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { HarnessLimits } from './continual/types.js';
import { type LlmBindingLimits } from './llm/binding.js';
import type { ReplPresentation } from './realm/protocol.js';
export declare const name = "prime-agent";
export declare const inject: string[];
/** Current configuration surface; removed legacy state and options are not accepted. */
export interface Config {
    stateDirectory: string;
    allowGlobalRefinement?: boolean;
    refinementMaxTokens?: number;
    refinementMaxConversationChars?: number;
    requireOrchestrationTools?: boolean;
    visibleOutputBudgetBytes?: number;
    continual?: Partial<HarnessLimits>;
    llm?: Partial<LlmBindingLimits>;
}
/** Schemastery configuration for the control plane and secondary learning layer. */
export declare const Config: z<Config>;
export interface ReplExecutionResult {
    logs: string[];
    result?: JsonValue;
    presentation?: ReplPresentation;
    /** Estimated tokens already in this conversation's context when the cell started, when the session meter is available. */
    contextTokens?: number;
    /** The routed model's context window in tokens, when the route declares one. */
    contextWindow?: number;
}
/** Render a canonical REPL result as notebook-style model text without changing its programmatic value. */
export declare function renderReplResult(value: ReplExecutionResult): string;
/** Register the sole model-visible REPL and its hidden host capabilities. */
export declare function apply(ctx: Context, config: Config): void;
export { HarnessStore, renderHarnessState } from './continual/store.js';
export type { HarnessChange, HarnessEdit, HarnessEntry, HarnessEntryKind, HarnessReference, HarnessScope, HarnessState, HarnessTransaction, } from './continual/types.js';
export { LLM_BINDING_DEFAULTS, type LlmBindingLimits } from './llm/binding.js';
//# sourceMappingURL=index.d.ts.map