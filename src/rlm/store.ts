import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  ArtifactReference,
  ContextEntry,
  ContextLimits,
  ContextManifest,
  ContextPutValue,
  ContextRead,
  ContextScope,
  ContextSearchMatch,
  ContextSearchResult,
  ContextValueKind,
} from './types.js'

function emptyManifest(scope: ContextScope, owner: string): ContextManifest {
  return { schemaVersion: 1, scope, owner, revision: 0, totalBytes: 0, entries: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function isJsonValue(value: unknown, ancestors: Set<object> = new Set()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false
    ancestors.add(value)
    const valid = value.every(item => isJsonValue(item, ancestors))
    ancestors.delete(value)
    return valid
  }
  if (!isRecord(value)) return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Object.values(value).every(item => item !== undefined && isJsonValue(item, ancestors))
  ancestors.delete(value)
  return valid
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xDC00 || next > 0xDFFF) return false
      index++
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false
    }
  }
  return true
}

function isLowSurrogate(value: string, index: number): boolean {
  const unit = value.charCodeAt(index)
  return unit >= 0xDC00 && unit <= 0xDFFF
}

function isHighSurrogate(value: string, index: number): boolean {
  const unit = value.charCodeAt(index)
  return unit >= 0xD800 && unit <= 0xDBFF
}

/** Slice on UTF-16 boundaries without emitting an isolated surrogate. */
function boundedUnicodeSlice(value: string, start: number, limit: number): string {
  if (start > 0 && isLowSurrogate(value, start) && isHighSurrogate(value, start - 1)) {
    throw new Error('prime-context: offset must not split a Unicode surrogate pair')
  }
  let end = Math.min(value.length, start + limit)
  if (end < value.length && isLowSurrogate(value, end) && isHighSurrogate(value, end - 1)) end--
  if (end === start && start < value.length) {
    throw new Error('prime-context: limit is too small for the next Unicode character')
  }
  return value.slice(start, end)
}

/** Return the largest prefix within a UTF-16 budget that remains well formed. */
function boundedUnicodePrefix(value: string, limit: number): string {
  let end = Math.min(value.length, limit)
  if (end < value.length && isLowSurrogate(value, end) && isHighSurrogate(value, end - 1)) end--
  return value.slice(0, end)
}

function unicodeWindow(value: string, start: number, end: number): string {
  let safeStart = start
  let safeEnd = Math.min(value.length, end)
  if (safeStart > 0 && isLowSurrogate(value, safeStart) && isHighSurrogate(value, safeStart - 1)) safeStart--
  if (safeEnd < value.length && isLowSurrogate(value, safeEnd) && isHighSurrogate(value, safeEnd - 1)) safeEnd--
  return value.slice(safeStart, safeEnd)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function normalizeText(value: string, label: string, maxChars: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`prime-context: ${label} must not be empty`)
  if (normalized.length > maxChars) throw new Error(`prime-context: ${label} exceeds ${maxChars} characters`)
  return normalized
}

function normalizeKey(value: string, limits: ContextLimits): string {
  const key = normalizeText(value, 'key', limits.maxKeyChars)
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(key)) throw new Error('prime-context: key must be a single line without control characters')
  return key
}

function normalizeSummary(value: string, label: string, limits: ContextLimits): string {
  const summary = normalizeText(value, label, limits.maxSummaryChars)
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(summary)) {
    throw new Error(`prime-context: ${label} must be a single line without control characters`)
  }
  return summary
}

function isEntry(value: unknown): value is ContextEntry {
  if (!isRecord(value) || !exactKeys(
    value,
    ['key', 'kind', 'summary', 'blobHash', 'bytes', 'version', 'createdAt', 'updatedAt'],
  )) return false
  return typeof value.key === 'string'
    && (value.kind === 'text' || value.kind === 'json' || value.kind === 'artifact')
    && typeof value.summary === 'string'
    && typeof value.blobHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.blobHash)
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0
    && Number.isSafeInteger(value.version) && (value.version as number) >= 1
    && Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0
    && Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) >= 0
}

function assertEntryLimits(entry: ContextEntry, limits: ContextLimits): void {
  normalizeKey(entry.key, limits)
  normalizeSummary(entry.summary, `summary for ${entry.key}`, limits)
  if (entry.bytes > limits.maxValueBytes) {
    throw new Error(`prime-context: ${entry.key} exceeds maxValueBytes (${limits.maxValueBytes})`)
  }
}

function parseManifest(text: string, scope: ContextScope, owner: string, limits: ContextLimits): ContextManifest {
  if (Buffer.byteLength(text, 'utf8') > limits.maxManifestBytes) {
    throw new Error(`prime-context: manifest for ${scope}/${owner} exceeds maxManifestBytes`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error(`prime-context: invalid manifest JSON for ${scope}/${owner}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'scope', 'owner', 'revision', 'totalBytes', 'entries'])) {
    throw new Error(`prime-context: invalid manifest shape for ${scope}/${owner}`)
  }
  if (value.schemaVersion !== 1 || value.scope !== scope || value.owner !== owner
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 0
    || !Array.isArray(value.entries) || !value.entries.every(isEntry)) {
    throw new Error(`prime-context: invalid manifest identity or fields for ${scope}/${owner}`)
  }
  if (value.entries.length > limits.maxEntriesPerScope) {
    throw new Error(`prime-context: manifest for ${scope}/${owner} exceeds maxEntriesPerScope`)
  }
  const keys = new Set<string>()
  let totalBytes = 0
  for (const entry of value.entries) {
    assertEntryLimits(entry, limits)
    if (entry.key !== entry.key.trim() || entry.summary !== entry.summary.trim()) {
      throw new Error(`prime-context: manifest entry ${JSON.stringify(entry.key)} is not normalized`)
    }
    if (keys.has(entry.key)) throw new Error(`prime-context: duplicate key ${JSON.stringify(entry.key)} in ${scope}/${owner}`)
    keys.add(entry.key)
    totalBytes += entry.bytes
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error(`prime-context: unsafe totalBytes for ${scope}/${owner}`)
    }
  }
  if (totalBytes !== value.totalBytes || totalBytes > limits.maxTotalBytesPerScope) {
    throw new Error(`prime-context: invalid or oversized totalBytes for ${scope}/${owner}`)
  }
  return value as unknown as ContextManifest
}

function serializeManifest(manifest: ContextManifest, limits: ContextLimits): string {
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  parseManifest(text, manifest.scope, manifest.owner, limits)
  return text
}

function normalizeArtifact(value: unknown, limits: ContextLimits): ArtifactReference {
  if (!isRecord(value) || !exactKeys(value, ['uri'], ['mediaType', 'description']) || typeof value.uri !== 'string') {
    throw new Error('prime-context: artifact value must be { uri, mediaType?, description? }')
  }
  const uri = normalizeText(value.uri, 'artifact uri', limits.maxValueBytes)
  if (value.mediaType !== undefined && typeof value.mediaType !== 'string') {
    throw new Error('prime-context: artifact mediaType must be a string')
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error('prime-context: artifact description must be a string')
  }
  return {
    uri,
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    ...(value.description === undefined ? {} : { description: value.description }),
  }
}

function serializeValue(kind: ContextValueKind, value: ContextPutValue, limits: ContextLimits): string {
  if (kind === 'text') {
    if (typeof value !== 'string') throw new Error('prime-context: text values must be strings')
    if (!isWellFormedUnicode(value)) throw new Error('prime-context: text values must contain well-formed Unicode')
    return value
  }
  if (kind === 'artifact') return JSON.stringify(normalizeArtifact(value, limits))
  if (!isJsonValue(value)) throw new Error('prime-context: json value is not lossless JSON')
  return JSON.stringify(value)
}

function resolveJsonPointer(value: JsonValue, pointer: string): JsonValue {
  if (pointer === '') return value
  if (!pointer.startsWith('/')) throw new Error('prime-context: JSON Pointer must be empty or start with /')
  let current: JsonValue = value
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(encoded)) {
      throw new Error(`prime-context: JSON Pointer token ${JSON.stringify(encoded)} contains an invalid escape`)
    }
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`prime-context: JSON Pointer token ${JSON.stringify(token)} is not an array index`)
      const index = Number(token)
      if (!Number.isSafeInteger(index)) throw new Error(`prime-context: JSON Pointer index ${JSON.stringify(token)} is not a safe integer`)
      const next = current[index]
      if (next === undefined) throw new Error(`prime-context: JSON Pointer does not resolve at ${JSON.stringify(token)}`)
      current = next
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, token)) throw new Error(`prime-context: JSON Pointer does not resolve at ${JSON.stringify(token)}`)
      const next = current[token]
      if (!isJsonValue(next)) throw new Error('prime-context: stored JSON violated the lossless JSON invariant')
      current = next
    } else {
      throw new Error(`prime-context: JSON Pointer cannot traverse ${typeof current}`)
    }
  }
  return current
}

/** Atomic manifest and content-addressed blob store for the RLM workspace. */
export class ContextStore {
  constructor(
    private readonly stateDirectory: string,
    private readonly limits: ContextLimits,
  ) {}

  /** Resolve the manifest path for one scope without embedding a session id in the filename. */
  manifestPath(scope: ContextScope, owner: string): string {
    if (scope === 'global') return join(this.stateDirectory, 'global.json')
    const digest = createHash('sha256').update(owner).digest('hex')
    return join(this.stateDirectory, 'sessions', `${digest}.json`)
  }

  /** Resolve the shared content-addressed blob path. */
  blobPath(hash: string): string {
    return join(this.stateDirectory, 'blobs', `${hash}.blob`)
  }

  /** Read a manifest synchronously for prompt assembly. */
  readManifestSync(scope: ContextScope, owner: string): ContextManifest {
    const filename = this.manifestPath(scope, owner)
    if (!existsSync(filename)) return emptyManifest(scope, owner)
    if (statSync(filename).size > this.limits.maxManifestBytes) {
      throw new Error(`prime-context: manifest ${filename} exceeds maxManifestBytes`)
    }
    return parseManifest(readFileSync(filename, 'utf8'), scope, owner, this.limits)
  }

  /** Read one atomic manifest snapshot. */
  async readManifest(scope: ContextScope, owner: string): Promise<ContextManifest> {
    const filename = this.manifestPath(scope, owner)
    try {
      if ((await stat(filename)).size > this.limits.maxManifestBytes) {
        throw new Error(`prime-context: manifest ${filename} exceeds maxManifestBytes`)
      }
      return parseManifest(await readFile(filename, 'utf8'), scope, owner, this.limits)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return emptyManifest(scope, owner)
      throw error
    }
  }

  /** Insert or replace one value after an optimistic revision check. */
  async put(
    scope: ContextScope,
    owner: string,
    expectedRevision: number,
    keyInput: string,
    kind: ContextValueKind,
    summaryInput: string,
    value: ContextPutValue,
  ): Promise<{ manifest: ContextManifest; entry: ContextEntry }> {
    if (kind !== 'text' && kind !== 'json' && kind !== 'artifact') {
      throw new Error('prime-context: kind must be text, json, or artifact')
    }
    const key = normalizeKey(keyInput, this.limits)
    const summary = normalizeSummary(summaryInput, 'summary', this.limits)
    const serialized = serializeValue(kind, value, this.limits)
    if (kind === 'artifact' && serialized.length > this.limits.maxReadChars) {
      throw new Error('prime-context: artifact reference exceeds maxReadChars')
    }
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > this.limits.maxValueBytes) {
      throw new Error(`prime-context: value exceeds maxValueBytes (${this.limits.maxValueBytes})`)
    }
    const blobHash = createHash('sha256').update(serialized).digest('hex')
    return this.mutate(scope, owner, expectedRevision, async (current) => {
      const previous = current.entries.find(entry => entry.key === key)
      const totalBytes = current.totalBytes - (previous?.bytes ?? 0) + bytes
      if (totalBytes > this.limits.maxTotalBytesPerScope) {
        throw new Error(`prime-context: scope would exceed maxTotalBytesPerScope (${this.limits.maxTotalBytesPerScope})`)
      }
      if (previous === undefined && current.entries.length >= this.limits.maxEntriesPerScope) {
        throw new Error(`prime-context: scope would exceed maxEntriesPerScope (${this.limits.maxEntriesPerScope})`)
      }
      await this.ensureBlob(blobHash, serialized)
      const now = Date.now()
      const entry: ContextEntry = {
        key,
        kind,
        summary,
        blobHash,
        bytes,
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      return {
        entry,
        manifest: {
          ...current,
          revision: current.revision + 1,
          totalBytes,
          entries: [...current.entries.filter(candidate => candidate.key !== key), entry]
            .sort((left, right) => left.key.localeCompare(right.key)),
        },
      }
    })
  }

  /** Delete one catalog entry after an optimistic revision check. Blobs remain immutable and may be reused. */
  async delete(
    scope: ContextScope,
    owner: string,
    expectedRevision: number,
    keyInput: string,
  ): Promise<{ manifest: ContextManifest; deleted: ContextEntry }> {
    const key = normalizeKey(keyInput, this.limits)
    return this.mutate(scope, owner, expectedRevision, (current) => {
      const deleted = current.entries.find(entry => entry.key === key)
      if (deleted === undefined) throw new Error(`prime-context: key ${JSON.stringify(key)} was not found`)
      return Promise.resolve({
        deleted,
        manifest: {
          ...current,
          revision: current.revision + 1,
          totalBytes: current.totalBytes - deleted.bytes,
          entries: current.entries.filter(entry => entry.key !== key),
        },
      })
    })
  }

  /** Read one value by text range or JSON Pointer. */
  async get(
    scope: ContextScope,
    owner: string,
    keyInput: string,
    options: { offset?: number; limit?: number; pointer?: string } = {},
  ): Promise<ContextRead> {
    const key = normalizeKey(keyInput, this.limits)
    const manifest = await this.readManifest(scope, owner)
    const entry = manifest.entries.find(candidate => candidate.key === key)
    if (entry === undefined) throw new Error(`prime-context: key ${JSON.stringify(key)} was not found`)
    const serialized = await this.readBlob(entry)
    if (entry.kind === 'artifact') {
      if (options.offset !== undefined || options.limit !== undefined || options.pointer !== undefined) {
        throw new Error('prime-context: artifact reads do not accept offset, limit, or pointer')
      }
      const value = JSON.parse(serialized) as unknown
      if (!isJsonValue(value)) throw new Error(`prime-context: artifact ${JSON.stringify(key)} is not lossless JSON`)
      if (serialized.length > this.limits.maxReadChars) {
        throw new Error('prime-context: artifact reference exceeds maxReadChars')
      }
      return { manifestRevision: manifest.revision, entry, format: 'artifact', value, truncated: false }
    }
    if (options.pointer !== undefined) {
      if (entry.kind !== 'json') throw new Error('prime-context: pointer is valid only for json values')
      if (options.offset !== undefined || options.limit !== undefined) {
        throw new Error('prime-context: pointer cannot be combined with offset or limit')
      }
      const parsed = JSON.parse(serialized) as unknown
      if (!isJsonValue(parsed)) throw new Error(`prime-context: json value ${JSON.stringify(key)} is not lossless JSON`)
      const value = resolveJsonPointer(parsed, options.pointer)
      if (JSON.stringify(value).length > this.limits.maxReadChars) {
        throw new Error('prime-context: selected JSON value exceeds maxReadChars; select a deeper pointer')
      }
      return { manifestRevision: manifest.revision, entry, format: 'json-value', value, truncated: false }
    }
    const offset = options.offset ?? 0
    const limit = options.limit ?? this.limits.maxReadChars
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('prime-context: offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxReadChars) {
      throw new Error(`prime-context: limit must be between 1 and ${this.limits.maxReadChars}`)
    }
    if (offset > serialized.length) throw new Error(`prime-context: offset ${offset} exceeds totalChars ${serialized.length}`)
    const content = boundedUnicodeSlice(serialized, offset, limit)
    const nextOffset = offset + content.length
    const truncated = nextOffset < serialized.length
    return {
      manifestRevision: manifest.revision,
      entry,
      format: entry.kind === 'text' ? 'text' : 'json-text',
      content,
      offset,
      ...(truncated ? { nextOffset } : {}),
      totalChars: serialized.length,
      truncated,
    }
  }

  /** Search text and serialized JSON values with bounded scanning and result windows. */
  async search(
    scope: ContextScope,
    owner: string,
    queryInput: string,
    options: { key?: string; caseSensitive?: boolean; limit?: number } = {},
  ): Promise<ContextSearchResult> {
    const query = normalizeText(queryInput, 'query', this.limits.maxSearchQueryChars)
    const limit = options.limit ?? this.limits.maxSearchMatches
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxSearchMatches) {
      throw new Error(`prime-context: search limit must be between 1 and ${this.limits.maxSearchMatches}`)
    }
    const manifest = await this.readManifest(scope, owner)
    const key = options.key === undefined ? undefined : normalizeKey(options.key, this.limits)
    const candidates = manifest.entries.filter(entry => entry.kind !== 'artifact' && (key === undefined || entry.key === key))
    if (key !== undefined && candidates.length === 0) throw new Error(`prime-context: searchable key ${JSON.stringify(key)} was not found`)
    const matches: ContextSearchMatch[] = []
    let scannedChars = 0
    let scannedEntries = 0
    let budgetExhausted = false
    let matchLimitReached = false
    for (const entry of candidates) {
      const remaining = this.limits.maxSearchChars - scannedChars
      if (remaining <= 0) {
        budgetExhausted = true
        break
      }
      const serialized = await this.readBlob(entry)
      const searchable = boundedUnicodePrefix(serialized, remaining)
      scannedChars += searchable.length
      scannedEntries++
      if (searchable.length < serialized.length) budgetExhausted = true
      if (options.caseSensitive === true) {
        for (let offset = searchable.indexOf(query); offset >= 0; offset = searchable.indexOf(query, offset + query.length)) {
          const beforeStart = Math.max(0, offset - this.limits.maxSearchWindowChars)
          const afterStart = offset + query.length
          matches.push({
            key: entry.key,
            offset,
            before: unicodeWindow(searchable, beforeStart, offset),
            match: searchable.slice(offset, afterStart),
            after: unicodeWindow(searchable, afterStart, afterStart + this.limits.maxSearchWindowChars),
          })
          if (matches.length >= limit) break
        }
      } else {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const expression = new RegExp(escaped, 'giu')
        for (const match of searchable.matchAll(expression)) {
          if (match.index === undefined) continue
          const offset = match.index
          const afterStart = offset + match[0].length
          matches.push({
            key: entry.key,
            offset,
            before: unicodeWindow(searchable, Math.max(0, offset - this.limits.maxSearchWindowChars), offset),
            match: match[0],
            after: unicodeWindow(searchable, afterStart, afterStart + this.limits.maxSearchWindowChars),
          })
          if (matches.length >= limit) break
        }
      }
      if (matches.length >= limit) matchLimitReached = true
      if (matches.length >= limit || budgetExhausted) break
    }
    return {
      manifestRevision: manifest.revision,
      query,
      matches,
      scannedEntries,
      omittedEntries: candidates.length - scannedEntries,
      scannedChars,
      budgetExhausted,
      matchLimitReached,
      truncated: budgetExhausted || matchLimitReached || candidates.length > scannedEntries,
    }
  }

  private async mutate<T extends { manifest: ContextManifest }>(
    scope: ContextScope,
    owner: string,
    expectedRevision: number,
    operation: (manifest: ContextManifest) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('prime-context: expected_revision must be a non-negative safe integer')
    }
    const filename = this.manifestPath(scope, owner)
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    return withFileLock(filename, async () => {
      const current = await this.readManifest(scope, owner)
      if (current.revision !== expectedRevision) {
        throw new Error(`prime-context: revision conflict; expected ${expectedRevision}, current ${current.revision}`)
      }
      const result = await operation(current)
      await writeFileAtomic(filename, serializeManifest(result.manifest, this.limits), { mode: 0o600, dirMode: 0o700 })
      return result
    })
  }

  private async ensureBlob(hash: string, content: string): Promise<void> {
    const filename = this.blobPath(hash)
    try {
      if ((await stat(filename)).size > this.limits.maxValueBytes) {
        throw new Error(`prime-context: content-addressed blob ${hash} exceeds maxValueBytes`)
      }
      const existing = await readFile(filename, 'utf8')
      if (createHash('sha256').update(existing).digest('hex') !== hash) {
        throw new Error(`prime-context: content-addressed blob ${hash} failed integrity validation`)
      }
      return
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    await writeFileAtomic(filename, content, { mode: 0o600, dirMode: 0o700 })
  }

  private async readBlob(entry: ContextEntry): Promise<string> {
    let content: string
    try {
      const filename = this.blobPath(entry.blobHash)
      const bytes = (await stat(filename)).size
      if (bytes !== entry.bytes || bytes > this.limits.maxValueBytes) {
        throw new Error(`prime-context: blob ${entry.blobHash} for ${JSON.stringify(entry.key)} has an invalid byte size`)
      }
      content = await readFile(filename, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        throw new Error(`prime-context: blob ${entry.blobHash} for ${JSON.stringify(entry.key)} is missing`)
      }
      throw error
    }
    if (Buffer.byteLength(content, 'utf8') !== entry.bytes
      || createHash('sha256').update(content).digest('hex') !== entry.blobHash) {
      throw new Error(`prime-context: blob ${entry.blobHash} for ${JSON.stringify(entry.key)} failed integrity validation`)
    }
    return content
  }
}

/** Render a bounded metadata-only catalog for dynamic prompt context. */
export function renderContextCatalog(manifest: ContextManifest, limits: ContextLimits): string {
  const header = `${manifest.scope} workspace revision ${manifest.revision}: ${manifest.entries.length} values, ${manifest.totalBytes} bytes`
  if (manifest.entries.length === 0) return `${header}\n- empty`
  const lines = [header]
  let used = header.length
  let included = 0
  for (const entry of manifest.entries.slice(0, limits.maxCatalogEntries)) {
    const line = `- ${entry.key} [${entry.kind}, v${entry.version}, ${entry.bytes} bytes] — ${entry.summary}`
    if (used + line.length + 1 > limits.maxCatalogChars) break
    lines.push(line)
    used += line.length + 1
    included++
  }
  const omitted = manifest.entries.length - included
  const omittedLine = `- ${omitted} catalog entries omitted by prompt budget`
  if (omitted > 0 && used + omittedLine.length + 1 <= limits.maxCatalogChars) lines.push(omittedLine)
  return lines.join('\n')
}
