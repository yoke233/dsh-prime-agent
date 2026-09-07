import { type Session } from '@deepseek-ai/dsh-session';
/** Read only conversation material and nested tool outcomes, never request headers or auth records. */
export declare function historyRecord(session: Session, seq: number): {
    seq: number;
    kind: string;
    text: string;
    searchText: string;
} | undefined;
/** Bound scan work as well as returned bytes; nextBefore advances even on an empty page. */
export declare function searchHistory(session: Session, query?: string, before?: number, limit?: number): {
    hits: {
        seq: number;
        kind: string;
        preview: string;
    }[];
    nextBefore: number | null;
};
/** Exact slices of the recorded JSON projection, including spill locators when the log copy spilled. */
export declare function readHistory(session: Session, seq: number, offset?: number, limit?: number): {
    seq: number;
    kind: string;
    text: string;
    totalChars: number;
    nextOffset: number | null;
};
/** A bounded navigation directory; quoted excerpts are clues, not a summary or new instructions. */
export declare function historyDirectory(session: Session): string;
//# sourceMappingURL=history.d.ts.map