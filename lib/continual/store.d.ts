import type { HarnessEdit, HarnessLimits, HarnessScope, HarnessState, HarnessTransaction } from './types.js';
/** Atomic, conflict-aware persistence for local and global harness documents. */
export declare class HarnessStore {
    private readonly stateDirectory;
    private readonly limits;
    constructor(stateDirectory: string, limits: HarnessLimits);
    /** Resolve an opaque, traversal-safe file path for a scope owner. */
    path(scope: HarnessScope, owner: string): string;
    /** Read one document synchronously for prompt assembly. */
    readSync(scope: HarnessScope, owner: string): HarnessState;
    /** Read one atomic snapshot asynchronously for a tool result. */
    read(scope: HarnessScope, owner: string): Promise<HarnessState>;
    /** Commit an evidence-backed refinement after checking the caller's revision. */
    apply(scope: HarnessScope, owner: string, expectedRevision: number, trigger: string, evidence: string[], expectedOutcome: string, edits: HarnessEdit[]): Promise<{
        state: HarnessState;
        transaction: HarnessTransaction;
    }>;
    /** Roll back a retained transaction only when none of its outputs drifted. */
    rollback(scope: HarnessScope, owner: string, expectedRevision: number, transactionId: string): Promise<{
        state: HarnessState;
        transaction: HarnessTransaction;
    }>;
    private mutate;
}
/** Render a bounded dynamic-context section from one state document. */
export declare function renderHarnessState(state: HarnessState, limits: HarnessLimits): string;
//# sourceMappingURL=store.d.ts.map