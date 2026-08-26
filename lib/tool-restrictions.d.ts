import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "prime-agent-tool-restrictions";
export declare const inject: string[];
export interface Config {
    /** Host-global tool names hidden from the calling Agent scope. */
    deny: string[];
}
export declare const Config: z<Config>;
/** Apply the preset-owned deny list to the calling Agent scope. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=tool-restrictions.d.ts.map