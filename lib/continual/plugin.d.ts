/** Secondary continual-learning layer for the Prime RLM workspace. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime';
import { HarnessStore } from './store.js';
import type { HarnessLimits } from './types.js';
export interface ContinualConfig {
    stateDirectory: string;
    allowGlobal: boolean;
    limits: HarnessLimits;
    maxTokens: number;
    maxConversationChars: number;
}
export interface RefineStatus {
    pending: boolean;
    in_flight: boolean;
    scheduled?: boolean;
    reason?: string;
}
export interface ContinualRuntime {
    store: HarnessStore;
    bindingFor(agent: Agent): CodeBindingNamespace;
}
/** Register replayable learning context, the packaged Skill provider, and its private Realm bridge. */
export declare function registerContinual(ctx: Context, config: ContinualConfig): ContinualRuntime;
//# sourceMappingURL=plugin.d.ts.map