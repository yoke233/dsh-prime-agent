export declare const PATCH_ERROR_CODES: {
    readonly invalidPatch: "INVALID_PATCH";
    readonly invalidHunk: "INVALID_HUNK";
    readonly invalidPath: "INVALID_PATH";
    readonly duplicatePath: "DUPLICATE_PATH";
    readonly unsupportedOperation: "UNSUPPORTED_OPERATION";
    readonly snapshotMissing: "SNAPSHOT_MISSING";
    readonly fileNotFound: "FILE_NOT_FOUND";
    readonly targetExists: "TARGET_EXISTS";
    readonly contextNotFound: "CONTEXT_NOT_FOUND";
    readonly contextAmbiguous: "CONTEXT_AMBIGUOUS";
    readonly hunkOutOfOrder: "HUNK_OUT_OF_ORDER";
    readonly capabilityUnavailable: "CAPABILITY_UNAVAILABLE";
    readonly snapshotReadFailed: "SNAPSHOT_READ_FAILED";
    readonly mutationFailed: "MUTATION_FAILED";
    readonly partialApply: "PARTIAL_APPLY";
};
export type PatchErrorCode = typeof PATCH_ERROR_CODES[keyof typeof PATCH_ERROR_CODES];
export interface PatchErrorDetails {
    path?: string;
    line?: number;
}
/** A stable, machine-readable parse or planning failure. */
export declare class PatchError extends Error {
    readonly name = "PatchError";
    readonly code: PatchErrorCode;
    readonly path: string | undefined;
    readonly line: number | undefined;
    constructor(code: PatchErrorCode, message: string, details?: PatchErrorDetails);
}
export interface ParsedAddFile {
    operation: 'add';
    path: string;
    lines: string[];
}
export interface ParsedDeleteFile {
    operation: 'delete';
    path: string;
}
export interface ParsedUpdateHunk {
    context: string | null;
    oldLines: string[];
    newLines: string[];
    endOfFile: boolean;
}
export interface ParsedUpdateFile {
    operation: 'update';
    path: string;
    movePath: string | null;
    hunks: ParsedUpdateHunk[];
}
export type ParsedFilePatch = ParsedAddFile | ParsedDeleteFile | ParsedUpdateFile;
export interface ParsedPatch {
    files: ParsedFilePatch[];
}
export interface PlannedFilePatch {
    path: string;
    operation: 'add' | 'update';
    content: string;
    hunks: number;
}
export interface PatchPlan {
    files: PlannedFilePatch[];
}
export interface AppliedPatchFile {
    path: string;
    operation: 'add' | 'update';
    hunks: number;
}
export interface ApplyPatchResult {
    applied: true;
    files: AppliedPatchFile[];
}
//# sourceMappingURL=types.d.ts.map