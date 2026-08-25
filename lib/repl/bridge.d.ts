import type { Context } from '@deepseek-ai/cordis';
import type { CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
export declare const REPL_TOOL_NAME = "repl";
export interface ReplBindings {
    bindings: CodeBindingNamespace[];
    finish(): Promise<void>;
}
/** Build one cell's leased host capabilities from the calling Agent's catalog. */
export declare function createReplBindings(ctx: Context, exec: ToolRunContext): ReplBindings;
//# sourceMappingURL=bridge.d.ts.map