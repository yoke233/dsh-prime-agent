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
/** What one placement attempt did. */
export type PresetInstallResult = 'installed' | 'already-present';
/** Where the packaged preset is read from and where it must end up. */
export interface PresetInstallOptions {
    /** The packaged preset directory, e.g. `<package>/agent-presets/prime`. */
    readonly sourceDir: string;
    /**
     * The preset directory to create, e.g. `<dshHome>/.agent-presets/prime`.
     * Its parent is created when absent; the directory itself is never touched
     * when it already exists.
     */
    readonly targetDir: string;
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
export declare function installPrimePreset(options: PresetInstallOptions): Promise<PresetInstallResult>;
//# sourceMappingURL=preset-install.d.ts.map