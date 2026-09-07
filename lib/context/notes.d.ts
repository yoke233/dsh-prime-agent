export interface TaskNote {
    revision: number;
    content: string;
}
/** One bounded, session-owned task note. File publication and cross-process locking belong to DSH. */
export declare class TaskNotes {
    private readonly directory;
    constructor(directory: string);
    private path;
    read(owner: string): Promise<TaskNote>;
    write(owner: string, revision: number, content: string, signal: AbortSignal): Promise<TaskNote>;
}
//# sourceMappingURL=notes.d.ts.map