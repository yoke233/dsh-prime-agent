import { PATCH_ERROR_CODES, PatchError, } from './types.js';
const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const END_OF_FILE = '*** End of File';
const ENVIRONMENT_ID = '*** Environment ID: ';
/** Parse the Codex apply-patch grammar without consulting the workspace. */
export function parsePatch(patch) {
    const lines = patchLines(patch);
    if (lines[0]?.trim() !== BEGIN_PATCH) {
        throw new PatchError(PATCH_ERROR_CODES.invalidPatch, `The first line must be '${BEGIN_PATCH}'.`, { line: 1 });
    }
    if (lines.at(-1)?.trim() !== END_PATCH) {
        throw new PatchError(PATCH_ERROR_CODES.invalidPatch, `The last line must be '${END_PATCH}'.`, {
            line: lines.length,
        });
    }
    const files = [];
    let index = 1;
    const endIndex = lines.length - 1;
    const environmentLine = lines[index]?.trim();
    if (environmentLine?.startsWith(ENVIRONMENT_ID)) {
        if (environmentLine.slice(ENVIRONMENT_ID.length).trim() === '') {
            throw new PatchError(PATCH_ERROR_CODES.invalidPatch, 'apply_patch environment_id cannot be empty', { line: index + 1 });
        }
        index += 1;
    }
    while (index < endIndex) {
        const header = lines[index];
        if (header === undefined)
            break;
        const parsedHeader = parseFileHeader(header.trim(), index + 1);
        const path = validatePath(parsedHeader.path, index + 1);
        index += 1;
        if (parsedHeader.operation === 'add') {
            const addedLines = [];
            while (index < endIndex && !isFileHeader(lines[index])) {
                const line = lines[index];
                if (line === undefined || !line.startsWith('+')) {
                    throw invalidHunk('Every Add File content line must start with +.', index + 1, path);
                }
                addedLines.push(line.slice(1));
                index += 1;
            }
            files.push({ operation: 'add', path, lines: addedLines });
            continue;
        }
        if (parsedHeader.operation === 'delete') {
            files.push({ operation: 'delete', path });
            continue;
        }
        let movePath = null;
        const moveLine = lines[index]?.trimEnd();
        if (moveLine?.startsWith(MOVE_TO)) {
            movePath = validatePath(moveLine.slice(MOVE_TO.length), index + 1);
            index += 1;
        }
        const hunks = [];
        let current = null;
        while (index < endIndex && !isFileHeader(lines[index])) {
            const line = lines[index];
            if (line === undefined)
                break;
            const updateLine = line.trimEnd();
            if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
                ensureHunkHasLines(current, index + 1, path);
                const context = updateLine === '@@' ? null : updateLine.slice(3);
                current = { context, oldLines: [], newLines: [], endOfFile: false };
                hunks.push(current);
                index += 1;
                continue;
            }
            if (updateLine === END_OF_FILE) {
                ensureHunkHasLines(current, index + 1, path);
                if (current === null)
                    throw invalidHunk('End of File must follow update lines.', index + 1, path);
                current.endOfFile = true;
                index += 1;
                continue;
            }
            if (updateLine.startsWith(MOVE_TO)) {
                throw invalidHunk('Move to must immediately follow the Update File header.', index + 1, path);
            }
            if (current === null) {
                current = { context: null, oldLines: [], newLines: [], endOfFile: false };
                hunks.push(current);
            }
            if (line === '') {
                current.oldLines.push('');
                current.newLines.push('');
            }
            else if (line.startsWith(' ')) {
                const contextLine = line.slice(1);
                current.oldLines.push(contextLine);
                current.newLines.push(contextLine);
            }
            else if (line.startsWith('+')) {
                current.newLines.push(line.slice(1));
            }
            else if (line.startsWith('-')) {
                current.oldLines.push(line.slice(1));
            }
            else {
                throw invalidHunk("Every Update File line must start with ' ', '+', or '-'.", index + 1, path);
            }
            index += 1;
        }
        ensureHunkHasLines(current, index + 1, path);
        if (hunks.length === 0) {
            throw invalidHunk('An Update File section must contain at least one hunk.', index + 1, path);
        }
        files.push({ operation: 'update', path, movePath, hunks });
    }
    return { files };
}
function patchLines(patch) {
    const normalized = patch.replaceAll('\r\n', '\n');
    const strayCarriageReturn = normalized.indexOf('\r');
    if (strayCarriageReturn !== -1) {
        const line = normalized.slice(0, strayCarriageReturn).split('\n').length;
        throw new PatchError(PATCH_ERROR_CODES.invalidPatch, 'Patch lines must use LF or CRLF line endings.', { line });
    }
    let lines = normalized.trim().split('\n');
    const first = lines[0];
    const last = lines.at(-1);
    if ((first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') && last === 'EOF' && lines.length >= 4) {
        lines = lines.slice(1, -1);
    }
    return lines;
}
function parseFileHeader(line, lineNumber) {
    if (line.startsWith(ADD_FILE))
        return { operation: 'add', path: line.slice(ADD_FILE.length) };
    if (line.startsWith(DELETE_FILE))
        return { operation: 'delete', path: line.slice(DELETE_FILE.length) };
    if (line.startsWith(UPDATE_FILE))
        return { operation: 'update', path: line.slice(UPDATE_FILE.length) };
    throw invalidHunk(`Expected '${ADD_FILE}{path}', '${DELETE_FILE}{path}', or '${UPDATE_FILE}{path}'.`, lineNumber);
}
function isFileHeader(line) {
    if (line === undefined || line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))
        return false;
    const trimmed = line.trim();
    return trimmed.startsWith(ADD_FILE)
        || trimmed.startsWith(DELETE_FILE)
        || trimmed.startsWith(UPDATE_FILE);
}
function validatePath(path, line) {
    if (path === '' || path.includes('\0'))
        throw invalidPath(path, line);
    return path;
}
function ensureHunkHasLines(hunk, line, path) {
    if (hunk !== null && hunk.oldLines.length === 0 && hunk.newLines.length === 0) {
        throw invalidHunk('An update hunk must contain at least one line.', line, path);
    }
}
function invalidPath(path, line) {
    return new PatchError(PATCH_ERROR_CODES.invalidPath, `Path '${path}' must be non-empty and must not contain NUL.`, { path, line });
}
function invalidHunk(message, line, path) {
    return new PatchError(PATCH_ERROR_CODES.invalidHunk, message, path === undefined ? { line } : { line, path });
}
//# sourceMappingURL=parser.js.map