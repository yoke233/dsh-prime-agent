/**
 * Placing the packaged Prime preset into the harness home.
 *
 * The roster's preset roots are decided by the host composition — `apps/cli`
 * overwrites the `agent-presets` row's `roots` with an overlay that keeps only
 * the shipped root — so a bundle patch cannot add a root of its own. What a
 * plugin CAN do is write into the one root the roster always scans, the
 * harness-home user root, and rely on discovery re-reading its roots on every
 * `list()`: the copy is visible to the next preset picker without a restart.
 *
 * Two rules make that safe to run on every startup. The copy happens only when
 * the target directory does not exist, so a user who edited their copy — or
 * deliberately deleted rows from it — never has that work overwritten by a
 * package upgrade. And the copy is assembled beside the target under a
 * temporary name and moved into place with a single rename, so the roster can
 * never scan a directory holding half a preset and report it broken.
 *
 * The module resolves no harness home of its own: both paths are inputs, which
 * keeps the DSH home resolution in one place (the caller's) and makes every
 * case here testable against a temporary directory.
 * @module dsh-prime-agent/realm/preset-install
 */
import { randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** The packaged preset directory is absent or is not a directory. */
class MissingPresetSourceError extends Error {
    constructor(sourceDir, options) {
        super(`dsh-prime-agent: packaged preset directory ${JSON.stringify(sourceDir)} is missing or is not a directory; `
            + 'the published package must ship agent-presets/prime', options);
    }
}
/** Whether anything at all occupies `path`, a dangling symlink included. */
async function occupied(path) {
    try {
        // `lstat`, not `stat`: a symlink pointing nowhere still owns the name, and
        // the rename below would fail on it. Treating it as free would turn a
        // user's own link into an error report instead of `already-present`.
        await lstat(path);
        return true;
    }
    catch {
        // Every failure means the same thing to this caller: nothing holds the
        // name, so the placement may claim it.
        return false;
    }
}
/**
 * Re-tighten a staged tree to owner-only, mirroring what the harness's own
 * preset copy does: an installed package is world-readable and `cp` preserves
 * that, while a preset under the harness home carries the same weight as the
 * settings document beside it. A file's owner-execute bit survives.
 */
async function tightenModes(dir) {
    await chmod(dir, 0o700);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const target = join(dir, entry.name);
        if (entry.isDirectory()) {
            await tightenModes(target);
        }
        else {
            await chmod(target, ((await stat(target)).mode & 0o100) === 0 ? 0o600 : 0o700);
        }
    }
}
/**
 * Place the packaged Prime preset at `targetDir`, unless something is already
 * there.
 *
 * Never overwrites and never merges: an occupied target — a complete copy, a
 * copy the user edited, an empty directory they created, a symlink — is
 * reported as `already-present` with no bytes written. Upgrading a placed copy
 * is therefore a deliberate act: delete the directory and restart.
 *
 * The staging directory is a sibling of the target so the final move is a
 * same-volume rename, and it is prefixed with a dot so a roster scan of the
 * parent ignores it even mid-copy. A rename that loses a race against another
 * process placing the same preset resolves to `already-present`, because the
 * outcome the caller wanted has happened.
 * @param options - the packaged source and the target directory.
 * @returns whether this call created the directory or found one already there.
 * @throws when the source is missing, or the copy fails for any reason other
 * than the target having appeared meanwhile.
 */
export async function installPrimePreset(options) {
    const { sourceDir, targetDir } = options;
    // Checked first, before the source is even read: when the preset is already
    // placed there is nothing this call can do, and a startup path must not fail
    // over a source directory it does not need.
    if (await occupied(targetDir))
        return 'already-present';
    let sourceIsDirectory;
    try {
        sourceIsDirectory = (await stat(sourceDir)).isDirectory();
    }
    catch (error) {
        throw new MissingPresetSourceError(sourceDir, { cause: error });
    }
    if (!sourceIsDirectory)
        throw new MissingPresetSourceError(sourceDir);
    const parent = dirname(targetDir);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = join(parent, `.prime-install-${randomBytes(8).toString('hex')}`);
    try {
        await cp(sourceDir, staging, { recursive: true, dereference: true, force: false, errorOnExist: true });
        // Best effort: Windows has no POSIX mode bits to tighten, and a filesystem
        // that rejects `chmod` must not turn a correct placement into a failure.
        if (process.platform !== 'win32')
            await tightenModes(staging);
        await rename(staging, targetDir);
    }
    catch (error) {
        await rm(staging, { recursive: true, force: true });
        // The rename is the only step another process can legitimately lose. If
        // the target exists now, that process won and the preset is placed.
        if (await occupied(targetDir))
            return 'already-present';
        throw error;
    }
    return 'installed';
}
//# sourceMappingURL=preset-install.js.map