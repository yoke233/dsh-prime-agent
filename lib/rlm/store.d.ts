import type { ContextEntry, ContextLimits, ContextManifest, ContextPutValue, ContextRead, ContextScope, ContextSearchResult, ContextValueKind } from './types.js';
/** Atomic manifest and content-addressed blob store for the RLM workspace. */
export declare class ContextStore {
    private readonly stateDirectory;
    private readonly limits;
    constructor(stateDirectory: string, limits: ContextLimits);
    /** Resolve the manifest path for one scope without embedding a session id in the filename. */
    manifestPath(scope: ContextScope, owner: string): string;
    /** Resolve the shared content-addressed blob path. */
    blobPath(hash: string): string;
    /** Read a manifest synchronously for prompt assembly. */
    readManifestSync(scope: ContextScope, owner: string): ContextManifest;
    /** Read one atomic manifest snapshot. */
    readManifest(scope: ContextScope, owner: string): Promise<ContextManifest>;
    /** Insert or replace one value after an optimistic revision check. */
    put(scope: ContextScope, owner: string, expectedRevision: number, keyInput: string, kind: ContextValueKind, summaryInput: string, value: ContextPutValue): Promise<{
        manifest: ContextManifest;
        entry: ContextEntry;
    }>;
    /** Delete one catalog entry after an optimistic revision check. Blobs remain immutable and may be reused. */
    delete(scope: ContextScope, owner: string, expectedRevision: number, keyInput: string): Promise<{
        manifest: ContextManifest;
        deleted: ContextEntry;
    }>;
    /** Read one value by text range or JSON Pointer. */
    get(scope: ContextScope, owner: string, keyInput: string, options?: {
        offset?: number;
        limit?: number;
        pointer?: string;
    }): Promise<ContextRead>;
    /** Search text and serialized JSON values with bounded scanning and result windows. */
    search(scope: ContextScope, owner: string, queryInput: string, options?: {
        key?: string;
        caseSensitive?: boolean;
        limit?: number;
    }): Promise<ContextSearchResult>;
    private mutate;
    private ensureBlob;
    private readBlob;
}
/** Render a bounded metadata-only catalog for dynamic prompt context. */
export declare function renderContextCatalog(manifest: ContextManifest, limits: ContextLimits): string;
//# sourceMappingURL=store.d.ts.map