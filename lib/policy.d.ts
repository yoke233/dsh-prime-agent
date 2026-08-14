import type { Context } from '@deepseek-ai/cordis';
/** Control-plane policy registration configuration resolved by the root plugin. */
export interface PolicyConfig {
    requireOrchestrationTools: boolean;
}
/** Register the Prime control-plane policy prompt section. */
export declare function registerPolicy(ctx: Context, config: PolicyConfig): void;
//# sourceMappingURL=policy.d.ts.map