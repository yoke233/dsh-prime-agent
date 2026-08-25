/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type JsonValue } from '@deepseek-ai/dsh-tools';
import type { HarnessLimits } from './continual/types.js';
import type { ReplPresentation } from './realm/protocol.js';
export declare const name = "prime-agent";
export declare const inject: string[];
/** Current configuration surface; removed legacy state and options are not accepted. */
export interface Config {
    stateDirectory: string;
    refineToolName?: string;
    allowGlobalRefinement?: boolean;
    requireOrchestrationTools?: boolean;
    continual?: Partial<HarnessLimits>;
}
/** Schemastery configuration for the control plane and secondary learning layer. */
export declare const Config: z<Config>;
export interface ReplExecutionResult {
    logs: string[];
    result?: JsonValue;
    presentation?: ReplPresentation;
}
/** Render a canonical REPL result as notebook-style model text without changing its programmatic value. */
export declare function renderReplResult(value: ReplExecutionResult): string;
/** Register the sole model-visible REPL and its hidden host capabilities. */
export declare function apply(ctx: Context, config: Config): void;
export { HarnessStore, renderHarnessState } from './continual/store.js';
export type { HarnessChange, HarnessEdit, HarnessEntry, HarnessEntryKind, HarnessReference, HarnessScope, HarnessState, HarnessTransaction, } from './continual/types.js';
//# sourceMappingURL=index.d.ts.map