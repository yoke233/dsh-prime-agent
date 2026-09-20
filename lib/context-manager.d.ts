import type { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine, type ModelCompactPolicyConfig } from '@deepseek-ai/dsh-compaction-basic';
import { type Message } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import z from '@deepseek-ai/schemastery';
export declare const name = "prime-context-manager";
export declare const inject: string[];
export interface Config {
    stateDirectory: string;
    thresholdRatio?: number;
    retainTokens?: number;
    /** Emit one task-note checkpoint reminder this many tokens before pressure compaction; omit to disable it. */
    checkpointReminderTokens?: number;
    modelPolicies?: Pick<ModelCompactPolicyConfig, 'provider' | 'model' | 'thresholdRatio' | 'retainTokens'>[];
}
export declare const Config: z<Config>;
/** Replace only the supported summarizer hook; DSH still owns transactions, pairing, metering and recovery. */
export declare class HistoryWindowEngine extends BasicCompactionEngine {
    protected summarize(input: {
        readonly messages: readonly Message[];
    }, agent: Agent, signal?: AbortSignal): Promise<{
        summary: {
            type: 'text';
            text: string;
        }[];
        provider: string;
        model: string;
    }>;
}
/** Mount the history window and its tools in the Prime preset's isolated compaction scope. */
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=context-manager.d.ts.map