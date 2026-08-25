export const PATCH_ERROR_CODES = {
  invalidPatch: 'INVALID_PATCH',
  invalidHunk: 'INVALID_HUNK',
  invalidPath: 'INVALID_PATH',
  unsupportedOperation: 'UNSUPPORTED_OPERATION',
  snapshotMissing: 'SNAPSHOT_MISSING',
  fileNotFound: 'FILE_NOT_FOUND',
  contextNotFound: 'CONTEXT_NOT_FOUND',
  capabilityUnavailable: 'CAPABILITY_UNAVAILABLE',
  snapshotReadFailed: 'SNAPSHOT_READ_FAILED',
  mutationFailed: 'MUTATION_FAILED',
  partialApply: 'PARTIAL_APPLY',
} as const

export type PatchErrorCode = typeof PATCH_ERROR_CODES[keyof typeof PATCH_ERROR_CODES]

export interface PatchErrorDetails {
  path?: string
  line?: number
}

/** A stable, machine-readable parse or planning failure. */
export class PatchError extends Error {
  override readonly name = 'PatchError'
  readonly code: PatchErrorCode
  readonly path: string | undefined
  readonly line: number | undefined

  constructor(code: PatchErrorCode, message: string, details: PatchErrorDetails = {}) {
    super(message)
    this.code = code
    this.path = details.path
    this.line = details.line
  }
}

export interface ParsedAddFile {
  operation: 'add'
  path: string
  lines: string[]
}

export interface ParsedDeleteFile {
  operation: 'delete'
  path: string
}

export interface ParsedUpdateHunk {
  context: string | null
  oldLines: string[]
  newLines: string[]
  endOfFile: boolean
}

export interface ParsedUpdateFile {
  operation: 'update'
  path: string
  movePath: string | null
  hunks: ParsedUpdateHunk[]
}

export type ParsedFilePatch = ParsedAddFile | ParsedDeleteFile | ParsedUpdateFile

export interface ParsedPatch {
  files: ParsedFilePatch[]
}

export interface PlannedFilePatch {
  path: string
  operation: 'add' | 'update'
  content: string
  hunks: number
}

export interface PatchPlan {
  files: PlannedFilePatch[]
}

export interface AppliedPatchFile {
  path: string
  operation: 'add' | 'update'
  hunks: number
}

export interface ApplyPatchResult {
  applied: true
  files: AppliedPatchFile[]
}
