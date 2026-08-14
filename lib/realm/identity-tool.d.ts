/** Fixed bootstrap binding that issues the calling session's realm token. */
import type { Context } from '@deepseek-ai/cordis';
/** Fixed, non-configurable binding name probed by the Prime code runtime. */
export declare const REALM_IDENTITY_TOOL_NAME = "prime_realm_identity";
/** The only user-visible text this tool ever renders. */
export declare const REALM_HANDSHAKE_TEXT = "Prime realm handshake completed";
/** Register the fixed realm handshake binding for the local owning agent. */
export declare function registerRealmIdentity(ctx: Context, options: {
    stateDirectory: string;
}): void;
//# sourceMappingURL=identity-tool.d.ts.map