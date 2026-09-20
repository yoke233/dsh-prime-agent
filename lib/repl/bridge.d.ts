import type { Context } from '@deepseek-ai/cordis';
import type { PtcBindingFunction, PtcBindingNamespace } from '@deepseek-ai/dsh-ptc-runtime';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
export declare const REPL_TOOL_NAME = "repl";
export interface ReplBindings {
    bindings: PtcBindingNamespace[];
    finish(): Promise<void>;
}
/**
 * Build one cell's leased host capabilities from the calling Agent's catalog.
 * `agentFunctions` are extra members installed on the `agents` namespace next
 * to the delegation aliases (they must not shadow an alias name); the namespace
 * exists whenever it has at least one member.
 */
export declare function createReplBindings(ctx: Context, exec: ToolRunContext, extraBindings?: readonly PtcBindingNamespace[], agentFunctions?: Readonly<Record<string, PtcBindingFunction>>): ReplBindings;
//# sourceMappingURL=bridge.d.ts.map