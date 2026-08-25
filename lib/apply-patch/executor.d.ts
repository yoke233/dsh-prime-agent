import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { type ApplyPatchResult } from './types.js';
/** Execute one fully preflighted patch through the owning Agent's registered read/write tools. */
export declare function executePatch(ctx: Context, args: {
    patch: string;
}, exec: ToolRunContext): Promise<ApplyPatchResult>;
//# sourceMappingURL=executor.d.ts.map