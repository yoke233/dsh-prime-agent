/**
 * The host plane's single `ctx.codeRuntime` provider: one runtime that answers
 * both kinds of request without letting either see the other's semantics.
 *
 * A request whose bindings carry the fixed `prime_realm_identity` bootstrap is a
 * Prime request. The runtime authenticates it — CSPRNG challenge, token, proof —
 * and routes the program to the persistent realm the token names. Every other
 * request is handed to the official one-shot runtime UNCHANGED. What is
 * deliberately impossible is the third path: a Prime request whose handshake
 * fails never falls back to one-shot, because a session that silently changed
 * state semantics mid-conversation is worse than a session that fails loudly.
 * @module dsh-prime-agent/realm/runtime
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingFunction, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { RealmIdentityStore } from './identity.js'
import type { RealmVerification } from './identity.js'
import { HIDDEN_BINDING_MEMBER, MIN_OUTPUT_BYTES, OutputLedger } from './protocol.js'
import { PersistentRealm } from './realm.js'
import type { RealmBudgets } from './realm.js'

/** The only handshake protocol version this runtime speaks. */
const HANDSHAKE_PROTOCOL = 1

/** Challenge width, fixed by `RealmIdentityStore`. */
const CHALLENGE_BYTES = 32

/** Node clamps a longer `setTimeout` delay to 1 ms, which would expire every run immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Floor and ceiling for the idle sweep cadence; the sweep itself is not config. */
const MIN_SWEEP_INTERVAL_MS = 25
const MAX_SWEEP_INTERVAL_MS = 60_000

/**
 * Bytes withheld from each realm's own output budget to pay for the trailing
 * state notice. The notice is appended after the realm finalized its ledger, so
 * without the reserve a program that filled its budget exactly would push the
 * result past the deployment's `maxOutputBytes`. Comfortably above the longest
 * notice this module can produce.
 */
const NOTICE_RESERVE_BYTES = 160

/**
 * Reclaimed-realm records kept for their state-loss report. Dropping the oldest
 * past this point costs only the generation NUMBER's continuity for a realm
 * nobody has touched in a very long time: without a record the realm is rebuilt
 * as a first run, which reports `started with an empty state` — still true.
 */
const MAX_LOST_HEAP_RECORDS = 1024

/** Everything the runtime needs that is not a per-run input. */
export interface PrimeCodeRuntimeOptions {
  /**
   * The absolute state directory this deployment shares with the agent-scoped
   * handshake tool. Both sides read the same `realm-identity/hmac.key`; a
   * mismatch makes every handshake fail closed rather than route anywhere.
   */
  stateDirectory: string
  /** The official one-shot runtime every non-Prime request is delegated to, verbatim. */
  fallback: CodeRuntime
  /** Per-run ceilings handed to every realm this runtime creates. */
  budgets: RealmBudgets
  /** Realms that may hold a worker at once; admission past it reclaims or refuses. */
  maxActiveRealms: number
  /** How long a realm may sit idle before its worker is reclaimed. */
  maxIdleMs: number
}

/** One live realm plus the generation history of the realm objects that preceded it. */
interface PoolEntry {
  realm: PersistentRealm
  /**
   * Generations already consumed for this realm id by EARLIER realm objects, so
   * the number the model sees never restarts after a reclamation.
   */
  generationBase: number
  /**
   * A reclamation destroyed this id's previous heap and no run has reported it
   * yet. Sticky until a run actually dispatches, so a run that never reaches a
   * worker cannot swallow the report.
   */
  reclaimed: boolean
  /** Whether any run has reached a worker on this realm object yet. */
  everDispatched: boolean
}

/** Render an unknown thrown value as a message, `Error` or not, without throwing again. */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unrenderable error value'
  }
}

/** Render an abort reason the way the shipped one-shot runtime does. */
function renderReason(reason: unknown): string {
  try {
    return String(reason)
  } catch {
    /* c8 ignore next -- only a reason whose own `toString` throws reaches this. */
    return 'aborted'
  }
}

/**
 * Replace any failure that is not the identity store's own bounded diagnostic.
 * A raw filesystem error carries the storage path, which must never reach a
 * model-visible result.
 */
function storageFailure(error: unknown): string {
  const message = messageOf(error)
  return message.startsWith('prime-realm-identity: ')
    ? message
    : 'prime-realm-identity: realm identity storage is unavailable'
}

/**
 * The handshake bootstrap this request declares, boxed so a declared-but-junk
 * member is distinguishable from no declaration at all. Own-property lookup
 * only: a `functions` record inheriting the name from its prototype is not a
 * declaration.
 */
function findHandshakeMember(request: CodeRunRequest): { value: unknown } | undefined {
  for (const namespace of request.bindings) {
    // Guarded per namespace: `functions` may be an accessor or a proxy, and a
    // throw here would reject `run()` for what the seam defines as a resolved
    // failure. A namespace that cannot be inspected simply declares nothing.
    try {
      const functions: unknown = namespace?.functions
      if (typeof functions !== 'object' || functions === null) continue
      if (!Object.hasOwn(functions, HIDDEN_BINDING_MEMBER)) continue
      return { value: (functions as Record<string, unknown>)[HIDDEN_BINDING_MEMBER] }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Accept only the exact handshake response shape. The bootstrap is a real tool
 * call travelling through the host's dispatch pipeline, so its result is data,
 * not a trusted structure: every field is re-checked and rebuilt.
 */
function parseHandshake(value: unknown): { token: string; proof: string } | undefined {
  // Wholly guarded: the response crossed the host's tool pipeline and may carry
  // throwing accessors. A throw escaping here would reject `run()`, which the
  // seam reserves for caller misuse — a bad response is a resolved failure.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.protocol !== HANDSHAKE_PROTOCOL) return undefined
    // Read each field ONCE. An accessor that answered the type check and then
    // returned something else on a second read would put an unvalidated value
    // into the verification call.
    const token: unknown = record.token
    const proof: unknown = record.proof
    if (typeof token !== 'string' || typeof proof !== 'string') return undefined
    return { token, proof }
  } catch {
    return undefined
  }
}

/**
 * The bounded state line appended to every realm run.
 *
 * `retained` is the only claim a model may act on, so it is made only when this
 * run executed on a worker an earlier run already used. A first run — brand-new
 * realm, a realm rebuilt after reclamation, or a host restart, all of which
 * present as a fresh worker — says `started` instead, which is true whether or
 * not a heap existed before.
 */
function generationNotice(generation: number, fresh: boolean, lost: boolean): string {
  if (!fresh) return `[prime-realm] generation ${generation} retained`
  return lost
    ? `[prime-realm] generation ${generation} started; live-only state from the previous generation was lost`
    : `[prime-realm] generation ${generation} started with an empty state`
}

/** Sweep often enough that a realm is reclaimed within 1.5x its idle ceiling. */
function sweepIntervalFor(maxIdleMs: number): number {
  return Math.min(Math.max(Math.ceil(maxIdleMs / 2), MIN_SWEEP_INTERVAL_MS), MAX_SWEEP_INTERVAL_MS)
}

/**
 * Reject budgets no realm could honour. `PersistentRealm` enforces the same
 * rules, but it is constructed lazily on first admission — checking here makes a
 * bad deployment fail at plugin load instead of on some session's first run.
 */
function assertBudgets(budgets: RealmBudgets): void {
  for (const [key, value] of Object.entries(budgets)) {
    if (!(Number.isFinite(value) && value > 0)) {
      throw new Error(`dsh-prime-agent: realm budget ${key} must be a positive number, got ${String(value)}`)
    }
  }
  // The floor carries the reserve too: a realm still needs its own minimum
  // after the trailing notice has been paid for.
  const floor = MIN_OUTPUT_BYTES + NOTICE_RESERVE_BYTES
  if (!Number.isSafeInteger(budgets.maxOutputBytes) || budgets.maxOutputBytes < floor) {
    throw new Error(`dsh-prime-agent: maxOutputBytes must be a safe integer of at least ${floor}`)
  }
  if (budgets.maxWallMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-prime-agent: maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps a longer setTimeout delay to 1ms)`)
  }
}

/**
 * The hybrid `ctx.codeRuntime`. See the module doc for the routing contract; the
 * Service Definition's contract is unchanged, so program, budget, abort and
 * substrate failures RESOLVE with `result.error` and only a disposed runtime or
 * an unusable binding declaration rejects.
 */
export class PrimeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'worker-thread'

  private readonly fallback: CodeRuntime
  private readonly identity: RealmIdentityStore
  private readonly budgets: RealmBudgets
  /** The deployment's full output cap, which a pre-worker failure may use whole. */
  private readonly outputBytes: number
  private readonly maxActiveRealms: number
  private readonly maxIdleMs: number
  private readonly pool = new Map<string, PoolEntry>()
  /**
   * Realm ids whose heap this runtime destroyed, mapped to the generation count
   * they had reached. Presence means "the next run for this id must be told its
   * live-only state is gone"; the record is consumed by that run. One small
   * record per reclaimed realm id survives, which is what makes a reclamation
   * distinguishable from a first-ever run.
   *
   * Deliberately PROCESS-LOCAL, and correct without durable state: realm ids
   * persist, but a restarted host presents every realm as a fresh worker, and a
   * fresh worker never reports `retained`. What a restart loses is only the
   * continuity of the generation NUMBER, not the truthfulness of the claim.
   */
  private readonly lostHeaps = new Map<string, number>()
  private readonly disposals = new Set<Promise<void>>()
  private disposed = false

  constructor(ctx: Context, options: PrimeCodeRuntimeOptions) {
    super(ctx)
    assertBudgets(options.budgets)
    if (!(Number.isSafeInteger(options.maxActiveRealms) && options.maxActiveRealms > 0)) {
      throw new Error(`dsh-prime-agent: maxActiveRealms must be a positive safe integer, got ${String(options.maxActiveRealms)}`)
    }
    if (!(Number.isFinite(options.maxIdleMs) && options.maxIdleMs > 0)) {
      throw new Error(`dsh-prime-agent: maxIdleMs must be a positive number, got ${String(options.maxIdleMs)}`)
    }
    this.fallback = options.fallback
    this.identity = new RealmIdentityStore({ directory: join(options.stateDirectory, 'realm-identity') })
    this.outputBytes = options.budgets.maxOutputBytes
    // Realms run against the budget MINUS the notice reserve, so the line this
    // runtime appends afterwards is already paid for.
    this.budgets = { ...options.budgets, maxOutputBytes: this.outputBytes - NOTICE_RESERVE_BYTES }
    this.maxActiveRealms = options.maxActiveRealms
    this.maxIdleMs = options.maxIdleMs

    // Armed INSIDE the effect so the timer cannot outlive a registration that
    // throws, and unref'd because reclamation is not a reason to keep the host
    // process alive.
    ctx.effect(() => {
      const sweep = setInterval(() => { this.sweepIdle() }, sweepIntervalFor(this.maxIdleMs))
      sweep.unref()
      return () => { clearInterval(sweep) }
    }, 'prime realm idle sweep')
    ctx.effect(() => () => this.teardown(), 'prime realm pool teardown')
  }

  /**
   * Route one request. A non-Prime request is delegated verbatim; a Prime
   * request is authenticated first and never degrades to the one-shot path.
   * @param request - the program, its bindings, and the abort signal.
   * @returns the run's outcome per the seam contract.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-prime-agent: prime code runtime run() after disposal')
    const bootstrap = findHandshakeMember(request)
    if (bootstrap === undefined) return await this.fallback.run(request)

    const signal = request.signal
    if (signal?.aborted) return this.aborted(signal)
    if (typeof bootstrap.value !== 'function') {
      return this.exception('realm handshake binding is not callable')
    }

    const challenge = randomBytes(CHALLENGE_BYTES)
    let issued: unknown
    try {
      issued = await (bootstrap.value as CodeBindingFunction)({
        protocol: HANDSHAKE_PROTOCOL,
        challenge: challenge.toString('base64url'),
      })
    } catch (error: unknown) {
      // An abort that fires while the bootstrap call is in flight surfaces as
      // the tool's own rejection; it is still an abort, not a failed handshake.
      if (signal?.aborted) return this.aborted(signal)
      return this.exception(`realm handshake binding failed: ${messageOf(error)}`)
    }
    if (signal?.aborted) return this.aborted(signal)

    const handshake = parseHandshake(issued)
    if (handshake === undefined) return this.exception('realm handshake returned a malformed response')

    let verification: RealmVerification
    try {
      verification = await this.identity.verify(handshake.token, handshake.proof, challenge)
    } catch (error: unknown) {
      return this.exception(storageFailure(error))
    }
    if (!verification.ok) return this.exception(`realm handshake rejected: ${verification.reason}`)
    if (signal?.aborted) return this.aborted(signal)

    return await this.execute(verification.realmId, request)
  }

  /** Admit the run into its realm and append the state notice the model needs. */
  private async execute(realmId: string, request: CodeRunRequest): Promise<CodeRunResult> {
    // Re-checked AFTER the handshake awaits: teardown may have run while the
    // bootstrap tool call was in flight, and admitting here would build a realm
    // and a worker that nothing is left to dispose.
    if (this.disposed) {
      return this.failure({ kind: 'abort', message: 'runtime disposed' })
    }
    const entry = this.acquire(realmId)
    if (entry === undefined) {
      return this.failure({ kind: 'exception', message: 'realm admission rejected: active realm limit reached' })
    }
    // The realm reports at DISPATCH, so the notice names the generation this
    // program actually ran in even when it waited behind other runs, and a run
    // that never reached a worker leaves the pending report for the one that does.
    let dispatched: string | undefined
    const result = await entry.realm.run(request, ({ generation, fresh, stateLost }) => {
      dispatched = generationNotice(entry.generationBase + generation, fresh, stateLost || entry.reclaimed)
      entry.reclaimed = false
      entry.everDispatched = true
    })
    // A run that never reached a worker reports the realm's CURRENT standing
    // without consuming it, so the run that does dispatch still gets told.
    const pendingLoss = entry.realm.generationNoticePending || entry.reclaimed
    const notice = dispatched ?? generationNotice(
      entry.generationBase + entry.realm.generation,
      pendingLoss || !entry.everDispatched,
      pendingLoss,
    )
    // Appended host-side rather than through the worker's ledger, which is why
    // every realm runs against a budget reduced by `NOTICE_RESERVE_BYTES`.
    return { ...result, logs: [...result.logs, notice] }
  }

  /** The realm for one id, creating or reclaiming as the pool ceiling allows. */
  private acquire(realmId: string): PoolEntry | undefined {
    const existing = this.pool.get(realmId)
    if (existing !== undefined) return existing
    if (this.pool.size >= this.maxActiveRealms && !this.reclaimLeastRecentlyUsed()) return undefined
    const generationBase = this.lostHeaps.get(realmId)
    this.lostHeaps.delete(realmId)
    const entry: PoolEntry = {
      realm: new PersistentRealm({ realmId, budgets: this.budgets }),
      generationBase: generationBase ?? 0,
      reclaimed: generationBase !== undefined,
      everDispatched: false,
    }
    this.pool.set(realmId, entry)
    return entry
  }

  /**
   * Free one admission slot by reclaiming the least recently used IDLE realm.
   * A realm with a run active or queued is never a candidate: reclaiming it
   * would kill a run that is already the caller's to abort.
   */
  private reclaimLeastRecentlyUsed(): boolean {
    let victimId: string | undefined
    let victim: PoolEntry | undefined
    for (const [candidateId, candidate] of this.pool) {
      if (!candidate.realm.idle) continue
      if (victim === undefined || candidate.realm.lastUsedAt < victim.realm.lastUsedAt) {
        victim = candidate
        victimId = candidateId
      }
    }
    if (victim === undefined || victimId === undefined) return false
    this.reclaim(victimId, victim)
    return true
  }

  /** Reclaim every realm that has been idle past the ceiling. */
  private sweepIdle(): void {
    // Cordis runs a fiber's disposers concurrently, so this timer can still fire
    // while `teardown` is awaiting worker termination; reclaiming there would
    // register a disposal nobody is waiting on any more.
    if (this.disposed) return
    const deadline = Date.now() - this.maxIdleMs
    for (const [realmId, entry] of [...this.pool]) {
      if (!entry.realm.idle || entry.realm.lastUsedAt > deadline) continue
      this.reclaim(realmId, entry)
    }
  }

  /**
   * Drop one realm from the pool and destroy its worker. The admission slot is
   * released synchronously while termination completes in the background, so a
   * terminating worker can briefly overlap its replacement; the ceiling governs
   * admission, not the instantaneous thread count.
   */
  private reclaim(realmId: string, entry: PoolEntry): void {
    this.pool.delete(realmId)
    this.lostHeaps.set(realmId, entry.generationBase + entry.realm.generation)
    // Insertion-ordered, so the first key is the oldest record.
    while (this.lostHeaps.size > MAX_LOST_HEAP_RECORDS) {
      const oldest = this.lostHeaps.keys().next()
      if (oldest.done === true) break
      this.lostHeaps.delete(oldest.value)
    }
    const disposal = entry.realm.dispose()
    this.disposals.add(disposal)
    void disposal.finally(() => { this.disposals.delete(disposal) })
  }

  /**
   * Stop admission, then terminate every realm and await complete settlement, so
   * no worker or in-flight binding call outlives the fiber.
   */
  private async teardown(): Promise<void> {
    this.disposed = true
    const entries = [...this.pool.values()]
    this.pool.clear()
    this.lostHeaps.clear()
    await Promise.all([...entries.map(entry => entry.realm.dispose()), ...this.disposals])
  }

  /**
   * A pre-worker outcome. It goes through the same ledger every other path uses,
   * because a handshake diagnostic interpolates a message from the host's tool
   * pipeline and must not be the one result that ignores the output cap.
   */
  private failure(error: CodeRunFailure): CodeRunResult {
    // No realm ran, so no notice is appended and the whole cap is available.
    return new OutputLedger(this.outputBytes).failure([], error)
  }

  /** A fail-closed handshake outcome; never a rejection of `run()`. */
  private exception(message: string): CodeRunResult {
    return this.failure({ kind: 'exception', message })
  }

  /** The abort outcome, matching the shipped one-shot runtime's rendering. */
  private aborted(signal: AbortSignal): CodeRunResult {
    return this.failure({ kind: 'abort', message: renderReason(signal.reason) })
  }
}

export default PrimeCodeRuntime
