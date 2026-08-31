import type { JsonValue } from '@deepseek-ai/dsh-util-values';
/** Continual-learning entry categories inherited from Prime Agent's Continual Harness. */
export type HarnessEntryKind = 'prompt' | 'memory' | 'skill' | 'subagent';
/** Persistence scope: one agent session or the whole deployment. */
export type HarnessScope = 'local' | 'global';
/** A callable route documented by a skill or subagent harness entry. */
export interface HarnessReference {
    tool: string;
    arguments: JsonValue;
}
/** One bounded, versioned continual-harness entry. */
export interface HarnessEntry {
    id: string;
    kind: HarnessEntryKind;
    title: string;
    content: string;
    reference?: HarnessReference;
    createdAt: number;
    updatedAt: number;
}
/** One before/after change retained for audit and conflict-safe rollback. */
export interface HarnessChange {
    id: string;
    kind: HarnessEntryKind;
    before: HarnessEntry | null;
    after: HarnessEntry | null;
}
/** One committed refinement or rollback transaction. */
export interface HarnessTransaction {
    id: string;
    type: 'refine' | 'rollback';
    trigger: string;
    evidence: string[];
    expectedOutcome: string;
    createdAt: number;
    changes: HarnessChange[];
    rollbackOf?: string;
}
/** Complete state document for one local or global scope. */
export interface HarnessState {
    schemaVersion: 1;
    scope: HarnessScope;
    owner: string;
    revision: number;
    entries: HarnessEntry[];
    transactions: HarnessTransaction[];
}
/** A model-authored entry mutation. */
export interface HarnessEdit {
    action: 'create' | 'update' | 'delete';
    kind: HarnessEntryKind;
    id: string;
    title?: string;
    content?: string;
    reference?: HarnessReference;
}
/** Resolved behavioral and storage limits used by the plugin. */
export interface HarnessLimits {
    maxEntriesPerScope: number;
    maxEntryIdChars: number;
    maxEntryTitleChars: number;
    maxEntryContentChars: number;
    maxReferenceToolChars: number;
    maxEvidenceItems: number;
    maxEvidenceChars: number;
    maxEditsPerTransaction: number;
    maxTransactions: number;
    maxStateBytes: number;
    maxPromptEntriesPerScope: number;
    maxPromptCharsPerScope: number;
}
//# sourceMappingURL=types.d.ts.map