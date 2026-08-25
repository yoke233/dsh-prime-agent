import { PATCH_ERROR_CODES, PatchError, } from './types.js';
const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const END_OF_FILE = '*** End of File';
/** Parse the Codex apply-patch grammar without consulting the workspace. */
export function parsePatch(patch) {
    const lines = patchLines(patch);
    if (lines[0] !== BEGIN_PATCH) {
        throw new PatchError(PATCH_ERROR_CODES.invalidPatch, `The first line must be '${BEGIN_PATCH}'.`, { line: 1 });
    }
    if (lines.at(-1) !== END_PATCH) {
        throw new PatchError(PATCH_ERROR_CODES.invalidPatch, `The last line must be '${END_PATCH}'.`, {
            line: lines.length,
        });
    }
    const files = [];
    const sourcePaths = new Set();
    let index = 1;
    const endIndex = lines.length - 1;
    while (index < endIndex) {
        const header = lines[index];
        if (header === undefined)
            break;
        const parsedHeader = parseFileHeader(header, index + 1);
        const path = normalizePath(parsedHeader.path, index + 1);
        if (sourcePaths.has(path)) {
            throw new PatchError(PATCH_ERROR_CODES.duplicatePath, `Patch contains the path '${path}' more than once.`, {
                path,
                line: index + 1,
            });
        }
        sourcePaths.add(path);
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
            if (addedLines.length === 0) {
                throw invalidHunk('An Add File section must contain at least one added line.', index + 1, path);
            }
            files.push({ operation: 'add', path, lines: addedLines });
            continue;
        }
        if (parsedHeader.operation === 'delete') {
            files.push({ operation: 'delete', path });
            continue;
        }
        let movePath = null;
        const moveLine = lines[index];
        if (moveLine?.startsWith(MOVE_TO)) {
            movePath = normalizePath(moveLine.slice(MOVE_TO.length), index + 1);
            index += 1;
        }
        const hunks = [];
        let current = null;
        let endedAtEof = false;
        while (index < endIndex && !isFileHeader(lines[index])) {
            const line = lines[index];
            if (line === undefined)
                break;
            if (line === '@@' || line.startsWith('@@ ')) {
                ensureHunkHasLines(current, index + 1, path);
                const context = line === '@@' ? null : line.slice(3);
                if (context === '')
                    throw invalidHunk('A named @@ context cannot be empty.', index + 1, path);
                current = { context, oldLines: [], newLines: [], endOfFile: false };
                hunks.push(current);
                endedAtEof = false;
                index += 1;
                continue;
            }
            if (line === END_OF_FILE) {
                ensureHunkHasLines(current, index + 1, path);
                if (current === null)
                    throw invalidHunk('End of File must follow update lines.', index + 1, path);
                current.endOfFile = true;
                endedAtEof = true;
                index += 1;
                continue;
            }
            if (endedAtEof) {
                throw invalidHunk('Only another @@ hunk may follow End of File.', index + 1, path);
            }
            if (line.startsWith(MOVE_TO)) {
                throw invalidHunk('Move to must immediately follow the Update File header.', index + 1, path);
            }
            if (current === null) {
                current = { context: null, oldLines: [], newLines: [], endOfFile: false };
                hunks.push(current);
            }
            if (line.startsWith(' ')) {
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
        if (hunks.length === 0 && movePath === null) {
            throw invalidHunk('An Update File section must contain at least one hunk.', index + 1, path);
        }
        files.push({ operation: 'update', path, movePath, hunks });
    }
    if (files.length === 0) {
        throw new PatchError(PATCH_ERROR_CODES.invalidPatch, 'A patch must contain at least one file section.', { line: 2 });
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
    const lines = normalized.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
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
    return line?.startsWith(ADD_FILE) === true
        || line?.startsWith(DELETE_FILE) === true
        || line?.startsWith(UPDATE_FILE) === true;
}
function normalizePath(path, line) {
    if (path === '' || path.includes('\0'))
        throw invalidPath(path, line);
    const portable = path.replaceAll('\\', '/');
    if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable))
        throw invalidPath(path, line);
    const segments = portable.split('/');
    if (segments.includes('..'))
        throw invalidPath(path, line);
    const normalized = segments.filter(segment => segment !== '' && segment !== '.').join('/');
    if (normalized === '')
        throw invalidPath(path, line);
    return normalized;
}
function ensureHunkHasLines(hunk, line, path) {
    if (hunk !== null && hunk.oldLines.length === 0 && hunk.newLines.length === 0) {
        throw invalidHunk('An update hunk must contain at least one line.', line, path);
    }
}
function invalidPath(path, line) {
    return new PatchError(PATCH_ERROR_CODES.invalidPath, `Path '${path}' must be a non-empty workspace-relative path without '..' or NUL.`, { path, line });
}
function invalidHunk(message, line, path) {
    return new PatchError(PATCH_ERROR_CODES.invalidHunk, message, path === undefined ? { line } : { line, path });
}
//# sourceMappingURL=parser.js.map