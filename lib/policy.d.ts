import type { Context } from '@deepseek-ai/cordis';
/** Control-plane policy registration configuration resolved by the root plugin. */
export interface PolicyConfig {
    requireOrchestrationTools: boolean;
}
/** Register concise guidance for the persistent REPL. */
export declare function registerPolicy(ctx: Context, config: PolicyConfig): void;
//# sourceMappingURL=policy.d.ts.map