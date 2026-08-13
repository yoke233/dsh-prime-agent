import type { JsonValue } from '@deepseek-ai/dsh-session'

/** Isolation boundary for one persistent RLM workspace. */
export type ContextScope = 'local' | 'global'

/** Supported durable value representations. */
export type ContextValueKind = 'text' | 'json' | 'artifact'

/** A durable reference to an artifact owned by another subsystem. */
export interface ArtifactReference {
  uri: string
  mediaType?: string
  description?: string
}

/** Catalog metadata for one value; content lives in a hash-addressed blob. */
export interface ContextEntry {
  key: string
  kind: ContextValueKind
  summary: string
  blobHash: string
  bytes: number
  version: number
  createdAt: number
  updatedAt: number
}

/** Atomic catalog document for one local or global workspace. */
export interface ContextManifest {
  schemaVersion: 1
  scope: ContextScope
  owner: string
  revision: number
  totalBytes: number
  entries: ContextEntry[]
}

/** Deployment-owned storage, quota, read, search, and prompt bounds. */
export interface ContextLimits {
  maxEntriesPerScope: number
  maxKeyChars: number
  maxSummaryChars: number
  maxValueBytes: number
  maxTotalBytesPerScope: number
  maxManifestBytes: number
  maxReadChars: number
  maxSearchQueryChars: number
  maxSearchMatches: number
  maxSearchWindowChars: number
  maxSearchChars: number
  maxCatalogEntries: number
  maxCatalogChars: number
}

/** Input accepted by {@link ContextStore.put}. */
export type ContextPutValue = string | JsonValue | ArtifactReference

/** One bounded value read. */
export interface ContextRead {
  manifestRevision: number
  entry: ContextEntry
  format: 'text' | 'json-text' | 'json-value' | 'artifact'
  content?: string
  value?: JsonValue
  offset?: number
  nextOffset?: number
  totalChars?: number
  truncated: boolean
}

/** One literal-search hit with an explicitly bounded context window. */
export interface ContextSearchMatch {
  key: string
  offset: number
  before: string
  match: string
  after: string
}

/** Result of one bounded workspace search. */
export interface ContextSearchResult {
  manifestRevision: number
  query: string
  matches: ContextSearchMatch[]
  scannedEntries: number
  omittedEntries: number
  scannedChars: number
  budgetExhausted: boolean
  matchLimitReached: boolean
  truncated: boolean
}
