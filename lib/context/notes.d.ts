import { SessionLogOffset } from '@deepseek-ai/dsh-session';
export interface TaskNote {
    revision: number;
    content: string;
    /** Exclusive Session log offset observed when this revision was written; null for legacy or absent notes. */
    updatedAtSessionOffset: SessionLogOffset | null;
}
export interface TaskNoteUpdate {
    revision: number;
    content: string;
    /** Trusted exclusive Session log offset supplied by the owning Host context. */
    updatedAtSessionOffset: SessionLogOffset;
}
/** One bounded, session-owned task note. File publication and cross-process locking belong to DSH. */
export declare class TaskNotes {
    private readonly directory;
    constructor(directory: string);
    private path;
    read(owner: string): Promise<TaskNote>;
    write(owner: string, update: TaskNoteUpdate, signal: AbortSignal): Promise<TaskNote>;
}
//# sourceMappingURL=notes.d.ts.map