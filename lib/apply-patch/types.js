export const PATCH_ERROR_CODES = {
    invalidPatch: 'INVALID_PATCH',
    invalidHunk: 'INVALID_HUNK',
    invalidPath: 'INVALID_PATH',
    duplicatePath: 'DUPLICATE_PATH',
    unsupportedOperation: 'UNSUPPORTED_OPERATION',
    snapshotMissing: 'SNAPSHOT_MISSING',
    fileNotFound: 'FILE_NOT_FOUND',
    targetExists: 'TARGET_EXISTS',
    contextNotFound: 'CONTEXT_NOT_FOUND',
    contextAmbiguous: 'CONTEXT_AMBIGUOUS',
    hunkOutOfOrder: 'HUNK_OUT_OF_ORDER',
    capabilityUnavailable: 'CAPABILITY_UNAVAILABLE',
    snapshotReadFailed: 'SNAPSHOT_READ_FAILED',
    mutationFailed: 'MUTATION_FAILED',
    partialApply: 'PARTIAL_APPLY',
};
/** A stable, machine-readable parse or planning failure. */
export class PatchError extends Error {
    name = 'PatchError';
    code;
    path;
    line;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.path = details.path;
        this.line = details.line;
    }
}
//# sourceMappingURL=types.js.map