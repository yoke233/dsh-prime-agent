/** Secondary continual-learning layer for the Prime RLM workspace. */
import type { Context } from '@deepseek-ai/cordis';
import { HarnessStore } from './store.js';
import type { HarnessLimits } from './types.js';
/** Deployment configuration for persistence, refinement bounds, and prompt budgets. */
export interface ContinualConfig {
    /** Private directory that stores the global document and hashed per-session documents. */
    stateDirectory: string;
    /** Whether model-authored transactions may modify deployment-global harness state. */
    allowGlobal: boolean;
    /** Registered model-facing tool name. */
    toolName: string;
    limits: HarnessLimits;
}
/** Register the tool plus static and replayable dynamic prompt contributions. */
export declare function registerContinual(ctx: Context, config: ContinualConfig): HarnessStore;
//# sourceMappingURL=plugin.d.ts.map