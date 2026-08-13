import type { Context } from '@deepseek-ai/cordis';
import { ContextStore } from './store.js';
import type { ContextLimits } from './types.js';
/** RLM workspace registration configuration resolved by the root plugin. */
export interface RlmConfig {
    stateDirectory: string;
    toolName: string;
    allowGlobal: boolean;
    requireOrchestrationTools: boolean;
    limits: ContextLimits;
}
/** Register the persistent RLM workspace tool and its metadata-only prompt catalog. */
export declare function registerRlm(ctx: Context, config: RlmConfig): ContextStore;
//# sourceMappingURL=plugin.d.ts.map