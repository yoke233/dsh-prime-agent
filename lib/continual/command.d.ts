/** Human-facing /refine command backed by the bounded continual harness store. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessStore } from './store.js';
import type { HarnessEdit, HarnessLimits, HarnessScope } from './types.js';
export interface RefineCommandConfig {
    allowGlobal: boolean;
    limits: HarnessLimits;
    maxTokens: number;
    maxConversationChars: number;
}
export interface RefineCommandOptions {
    scope: HarnessScope;
    instructions?: string;
    rollbackId?: string;
}
interface RefinementProposal {
    rationale: string;
    trigger?: string;
    evidence?: string[];
    expectedOutcome?: string;
    edits: HarnessEdit[];
}
/** Parse the Prime-compatible manual refinement and rollback forms. */
export declare function parseRefineCommandOptions(rawInput: string): RefineCommandOptions;
/** Parse and minimally shape-check model output; HarnessStore remains the bounds authority. */
export declare function parseRefinementProposal(output: string): RefinementProposal;
/** Enforce the shared callable-entry policy for model tool and slash-command writes. */
export declare function assertCallableReferences(ctx: Context, agent: Agent | undefined, scope: HarnessScope, edits: readonly HarnessEdit[]): void;
/** Register /refine when the host command service is composed. */
export declare function registerRefineCommand(ctx: Context, store: HarnessStore, config: RefineCommandConfig): void;
export {};
//# sourceMappingURL=command.d.ts.map