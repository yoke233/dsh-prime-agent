/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { HarnessLimits } from './continual/types.js';
export declare const name = "prime-agent";
export declare const inject: string[];
/** Clean v0.2 configuration; no v0.1 state or option compatibility is retained. */
export interface Config {
    stateDirectory: string;
    refineToolName?: string;
    allowGlobalRefinement?: boolean;
    requireCodeMode?: boolean;
    requireOrchestrationTools?: boolean;
    continual?: Partial<HarnessLimits>;
}
/** Schemastery configuration for the control plane and secondary learning layer. */
export declare const Config: z<Config>;
/** Register the control-plane policy, learning layer, and strict Code Mode assembly invariant. */
export declare function apply(ctx: Context, config: Config): void;
export { HarnessStore, renderHarnessState } from './continual/store.js';
export type { HarnessChange, HarnessEdit, HarnessEntry, HarnessEntryKind, HarnessReference, HarnessScope, HarnessState, HarnessTransaction, } from './continual/types.js';
//# sourceMappingURL=index.d.ts.map