import { PATCH_ERROR_CODES, PatchError, } from './types.js';
import { seekSequence } from './seek-sequence.js';
/** Compute every final file body without performing any mutation. */
export function planPatch(parsed, snapshots) {
    rejectUnsupportedOperations(parsed);
    if (parsed.files.length === 0) {
        throw new PatchError(PATCH_ERROR_CODES.invalidPatch, 'No files were modified.');
    }
    const files = [];
    const currentSnapshots = new Map(snapshots);
    for (const file of parsed.files) {
        if (!currentSnapshots.has(file.path)) {
            throw new PatchError(PATCH_ERROR_CODES.snapshotMissing, `No preflight snapshot was provided for '${file.path}'.`, { path: file.path });
        }
        const snapshot = currentSnapshots.get(file.path);
        if (file.operation === 'add') {
            const content = file.lines.length === 0 ? '' : `${file.lines.join('\n')}\n`;
            files.push({
                path: file.path,
                operation: 'add',
                content,
                hunks: 1,
            });
            currentSnapshots.set(file.path, content);
            continue;
        }
        if (file.operation !== 'update') {
            throw new PatchError(PATCH_ERROR_CODES.unsupportedOperation, `Delete File is not supported for '${file.path}'.`, {
                path: file.path,
            });
        }
        if (snapshot === null) {
            throw new PatchError(PATCH_ERROR_CODES.fileNotFound, `Cannot update '${file.path}' because it does not exist.`, {
                path: file.path,
            });
        }
        if (snapshot === undefined) {
            throw new PatchError(PATCH_ERROR_CODES.snapshotMissing, `No preflight snapshot was provided for '${file.path}'.`, { path: file.path });
        }
        const content = applyUpdate(file, snapshot);
        files.push({
            path: file.path,
            operation: 'update',
            content,
            hunks: file.hunks.length,
        });
        currentSnapshots.set(file.path, content);
    }
    return { files };
}
function rejectUnsupportedOperations(parsed) {
    for (const file of parsed.files) {
        if (file.operation === 'delete') {
            throw new PatchError(PATCH_ERROR_CODES.unsupportedOperation, `Delete File is not supported for '${file.path}'.`, {
                path: file.path,
            });
        }
        if (file.operation === 'update' && file.movePath !== null) {
            throw new PatchError(PATCH_ERROR_CODES.unsupportedOperation, `Move to '${file.movePath}' is not supported for '${file.path}'.`, { path: file.path });
        }
    }
}
function applyUpdate(file, snapshot) {
    const originalLines = snapshot.split('\n');
    if (originalLines.at(-1) === '')
        originalLines.pop();
    const replacements = [];
    let cursor = 0;
    for (const hunk of file.hunks) {
        if (hunk.context !== null) {
            const contextPosition = seekSequence(originalLines, [hunk.context], cursor, false);
            if (contextPosition === null) {
                throw hunkError(PATCH_ERROR_CODES.contextNotFound, file.path, `Failed to find context '${hunk.context}' in ${file.path}`);
            }
            cursor = contextPosition + 1;
        }
        if (hunk.oldLines.length === 0) {
            replacements.push([originalLines.length, 0, hunk.newLines]);
            continue;
        }
        let pattern = hunk.oldLines;
        let newLines = hunk.newLines;
        let position = seekSequence(originalLines, pattern, cursor, hunk.endOfFile);
        if (position === null && pattern.at(-1) === '') {
            pattern = pattern.slice(0, -1);
            if (newLines.at(-1) === '')
                newLines = newLines.slice(0, -1);
            position = seekSequence(originalLines, pattern, cursor, hunk.endOfFile);
        }
        if (position === null) {
            throw hunkError(PATCH_ERROR_CODES.contextNotFound, file.path, `Failed to find expected lines in ${file.path}:\n${hunk.oldLines.join('\n')}`);
        }
        replacements.push([position, pattern.length, newLines]);
        cursor = position + pattern.length;
    }
    replacements.sort((left, right) => left[0] - right[0]);
    for (const [position, oldLength, newLines] of replacements.reverse()) {
        originalLines.splice(position, oldLength, ...newLines);
    }
    if (originalLines.at(-1) !== '')
        originalLines.push('');
    return originalLines.join('\n');
}
function hunkError(code, path, message) {
    return new PatchError(code, message, { path });
}
//# sourceMappingURL=planner.js.map