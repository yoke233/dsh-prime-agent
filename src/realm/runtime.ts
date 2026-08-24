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
 * persistence semantics mid-conversation is worse than a session that fails loudly.
 * @module dsh-prime-agent/realm/runtime
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingFunction, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { RealmIdentityStore } from './identity.js'
import type { RealmVerification } from './identity.js'
import {
  HIDDEN_BINDING_MEMBER,
  MIN_OUTPUT_BYTES,
  OutputLedger,
  resolveCompletionHistoryLimits,
  resolveCompletionProjectionLimits,
} from './protocol.js'
import type { RealmCompletionHistoryLimits, RealmCompletionProjectionLimits } from './protocol.js'
import { acquireRealmLease, RealmLeaseError } from './realm-lease.js'
import { addRealmMetrics, emptyRealmMetrics, PersistentRealm } from './realm.js'
import type { RealmBudgets, RealmMetrics, RealmRunNotice } from './realm.js'

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
 * namespace lifecycle notice. The notice is appended after the realm finalized
 * its ledger, so without the reserve a program that filled its budget exactly
 * would push the result past the deployment's `maxOutputBytes`.
 */
const NOTICE_RESERVE_BYTES = 512

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
  /**
   * Completion-history ceilings for every realm this runtime creates. Blank
   * fields take the plan defaults; the history exists only on this authenticated
   * Prime path, so the one-shot fallback keeps the official semantics exactly.
   */
  completionHistory?: Partial<RealmCompletionHistoryLimits>
  /**
   * Projection ceilings for every realm this runtime creates: the size past
   * which a completion is referenced rather than shown, and how much a reference
   * may itself cost. Blank fields take the plan defaults.
   */
  completionProjection?: Partial<RealmCompletionProjectionLimits>
  /** Realms that may hold a worker at once; admission past it reclaims or refuses. */
  maxActiveRealms: number
  /** How long a realm may sit idle before its worker is reclaimed. */
  maxIdleMs: number
}

/** One Prime call's place in the pre-realm admission order. */
interface PrimeAdmissionTurn {
  previous: Promise<void>
  release: () => void
}

/** One run synchronously enqueued while its pool/lease admission was stable. */
interface RealmAdmission {
  result: Promise<CodeRunResult>
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

/** Bound a lazy cross-process Realm-ownership failure for model-visible output. */
function realmOwnershipFailure(error: unknown): string {
  return error instanceof RealmLeaseError
    ? error.message
    : 'dsh-prime-agent: Prime session ownership is unavailable'
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
 * Render the one lifecycle fact a fresh worker needs to expose. The restart line
 * names the completion history too, because a hard kill takes both with it and
 * the plan deliberately keeps ONE restart mechanism rather than adding a second
 * notice for the history.
 */
function namespaceNotice(fresh: boolean, lost: boolean): string | undefined {
  if (lost) return '[prime-realm] live namespace restarted; previous bindings and retained results were lost'
  if (fresh) return '[prime-realm] live namespace started empty'
  return undefined
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
  private readonly completionHistory: RealmCompletionHistoryLimits
  private readonly completionProjection: RealmCompletionProjectionLimits
  /**
   * Counters inherited from realms this runtime has already retired, so the
   * totals describe the whole process rather than only the realms still pooled.
   * A retired realm holds nothing, so its history LEVELS are dropped here rather
   * than carried forward.
   */
  private readonly retiredMetrics = emptyRealmMetrics()
  /** The deployment's full output cap, which a pre-worker failure may use whole. */
  private readonly outputBytes: number
  private readonly maxActiveRealms: number
  private readonly maxIdleMs: number
  private readonly leaseDirectory: string
  private readonly pool = new Map<string, PersistentRealm>()
  /** Cross-process claims for Realms whose worker is live or still terminating. */
  private readonly realmLeases = new Map<string, () => Promise<void>>()
  private readonly retirements = new Map<string, Promise<void>>()
  /** Serializes the async claim + synchronous pool-admission decision. */
  private poolMutationTail = Promise.resolve()
  // A request's realm id is authenticated asynchronously, so its place must be
  // reserved before the handshake can finish out of order. The turn ends as
  // soon as realm.run() has enqueued the cell; realm execution stays per-realm.
  private admissionTail = Promise.resolve()
  private releaseAdmissionStop!: () => void
  private readonly admissionStopped = new Promise<void>((resolve) => { this.releaseAdmissionStop = resolve })
  private disposed = false

  constructor(ctx: Context, options: PrimeCodeRuntimeOptions) {
    super(ctx)
    assertBudgets(options.budgets)
    // Resolved at construction rather than at first admission, so a bad
    // deployment fails at plugin load instead of on some session's first run.
    this.completionHistory = resolveCompletionHistoryLimits(options.completionHistory)
    this.completionProjection = resolveCompletionProjectionLimits(options.completionProjection)
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
    this.leaseDirectory = join(options.stateDirectory, 'realm-identity', 'leases')

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
   * Bounded completion counters across every realm this runtime has hosted
   * (plan §11).
   *
   * Exposed as a getter and nothing else: the numbers are for tests and for a
   * deployment that wants to check the mechanism is reducing tokens rather than
   * only relabelling failures. They never reach a logger, the Session, the wire
   * or the model, and they carry no content.
   */
  get metrics(): RealmMetrics {
    const total = addRealmMetrics(emptyRealmMetrics(), this.retiredMetrics)
    for (const realm of this.pool.values()) addRealmMetrics(total, realm.metrics)
    return total
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
    const admission = this.reserveAdmission()
    const finish = (action: () => CodeRunResult | Promise<CodeRunResult>): Promise<CodeRunResult> => {
      return this.finishAdmission(admission, action)
    }
    let issued: unknown
    try {
      issued = await (bootstrap.value as CodeBindingFunction)({
        protocol: HANDSHAKE_PROTOCOL,
        challenge: challenge.toString('base64url'),
      })
    } catch (error: unknown) {
      // An abort that fires while the bootstrap call is in flight surfaces as
      // the tool's own rejection; it is still an abort, not a failed handshake.
      if (signal?.aborted) return await finish(() => this.aborted(signal))
      return await finish(() => this.exception(`realm handshake binding failed: ${messageOf(error)}`))
    }
    if (signal?.aborted) return await finish(() => this.aborted(signal))

    const handshake = parseHandshake(issued)
    if (handshake === undefined) return await finish(() => this.exception('realm handshake returned a malformed response'))

    let verification: RealmVerification
    try {
      verification = await this.identity.verify(handshake.token, handshake.proof, challenge)
    } catch (error: unknown) {
      return await finish(() => this.exception(storageFailure(error)))
    }
    if (!verification.ok) return await finish(() => this.exception(`realm handshake rejected: ${verification.reason}`))

    return await finish(() => signal?.aborted
      ? this.aborted(signal)
      : this.execute(verification.realmId, request))
  }

  /** Reserve call order before authentication reveals which realm owns it. */
  private reserveAdmission(): PrimeAdmissionTurn {
    const previous = this.admissionTail
    let release!: () => void
    this.admissionTail = new Promise<void>((resolve) => { release = resolve })
    return { previous, release }
  }

  /**
   * Start one authenticated outcome in call order, then immediately release the
   * next admission. `action()` synchronously enqueues a valid cell before it
   * returns its settlement promise, so this never serializes different realms.
   */
  private async finishAdmission(
    turn: PrimeAdmissionTurn,
    action: () => CodeRunResult | Promise<CodeRunResult>,
  ): Promise<CodeRunResult> {
    await Promise.race([turn.previous, this.admissionStopped])
    let outcome: CodeRunResult | Promise<CodeRunResult>
    try {
      outcome = action()
    } finally {
      turn.release()
    }
    return await outcome
  }

  /** Admit the run into its realm and append a fresh-namespace notice when needed. */
  private async execute(realmId: string, request: CodeRunRequest): Promise<CodeRunResult> {
    // Re-checked AFTER the handshake awaits: teardown may have run while the
    // bootstrap tool call was in flight, and admitting here would build a realm
    // and a worker that nothing is left to dispose.
    if (this.disposed) {
      return this.failure({ kind: 'abort', message: 'runtime disposed' })
    }
    // The realm reports at DISPATCH, so a run that never reaches a worker neither
    // emits nor consumes the pending loss report.
    let notice: string | undefined
    let admission: RealmAdmission | undefined
    try {
      admission = await this.admit(realmId, request, ({ fresh, namespaceLost }) => {
        notice = namespaceNotice(fresh, namespaceLost)
      })
    } catch (error: unknown) {
      return this.failure({ kind: 'exception', message: realmOwnershipFailure(error) })
    }
    if (admission === undefined) {
      return this.disposed
        ? this.failure({ kind: 'abort', message: 'runtime disposed' })
        : this.failure({ kind: 'exception', message: 'realm admission rejected: active realm limit reached' })
    }
    const result = await admission.result
    if (notice === undefined) return result
    // Appended host-side rather than through the worker's ledger, which is why
    // every realm runs against a budget reduced by `NOTICE_RESERVE_BYTES`.
    return { ...result, logs: [...result.logs, notice] }
  }

  /**
   * Enqueue one run while its Realm cannot be reclaimed. Existing Realms take a
   * synchronous fast path; only first-use claim and pool-capacity changes enter
   * the async mutation queue.
   */
  private async admit(
    realmId: string,
    request: CodeRunRequest,
    onStart: (notice: RealmRunNotice) => void,
  ): Promise<RealmAdmission | undefined> {
    if (this.disposed) return undefined
    const ready = this.pool.get(realmId)
    if (ready !== undefined) return { result: ready.run(request, onStart) }

    const previous = this.poolMutationTail
    let releaseMutation!: () => void
    this.poolMutationTail = new Promise<void>((resolve) => { releaseMutation = resolve })
    await previous
    try {
      if (this.disposed) return undefined
      const existing = this.pool.get(realmId)
      if (existing !== undefined) return { result: existing.run(request, onStart) }

      const retiring = this.retirements.get(realmId)
      if (retiring !== undefined) await retiring
      if (this.disposed) return undefined

      let claimedNow: (() => Promise<void>) | undefined
      if (!this.realmLeases.has(realmId)) {
        claimedNow = await acquireRealmLease(this.leaseDirectory, realmId)
        if (this.disposed) {
          await claimedNow()
          return undefined
        }
        this.realmLeases.set(realmId, claimedNow)
      }

      if (this.pool.size >= this.maxActiveRealms && !this.reclaimLeastRecentlyUsed()) {
        if (claimedNow !== undefined) {
          this.realmLeases.delete(realmId)
          await claimedNow()
        }
        return undefined
      }

      try {
        const realm = new PersistentRealm({
          realmId,
          budgets: this.budgets,
          completionHistory: this.completionHistory,
          completionProjection: this.completionProjection,
        })
        this.pool.set(realmId, realm)
        return { result: realm.run(request, onStart) }
      } catch (error: unknown) {
        if (claimedNow !== undefined) {
          this.realmLeases.delete(realmId)
          await claimedNow()
        }
        throw error
      }
    } finally {
      releaseMutation()
    }
  }

  /**
   * Free one admission slot by reclaiming the least recently used IDLE realm.
   * A realm with a run active or queued is never a candidate: reclaiming it
   * would kill a run that is already the caller's to abort.
   */
  private reclaimLeastRecentlyUsed(): boolean {
    let victimId: string | undefined
    let victim: PersistentRealm | undefined
    for (const [candidateId, candidate] of this.pool) {
      if (!candidate.idle) continue
      if (victim === undefined || candidate.lastUsedAt < victim.lastUsedAt) {
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
    for (const [realmId, realm] of [...this.pool]) {
      if (!realm.idle || realm.lastUsedAt > deadline) continue
      this.reclaim(realmId, realm)
    }
  }

  /**
   * Drop one realm from the pool and destroy its worker. The admission slot is
   * released synchronously while termination completes in the background, so a
   * terminating worker can briefly overlap its replacement; the ceiling governs
   * admission, not the instantaneous thread count.
   */
  private reclaim(realmId: string, realm: PersistentRealm): void {
    this.pool.delete(realmId)
    // Take its counters before the worker goes: reclamation releases the whole
    // history, so the levels it was reporting stop being true immediately.
    addRealmMetrics(this.retiredMetrics, { ...realm.metrics, historyEntries: 0, historyBytes: 0 })
    const retirement = (async () => {
      try {
        await realm.dispose()
      } finally {
        const release = this.realmLeases.get(realmId)
        if (release !== undefined) {
          this.realmLeases.delete(realmId)
          await release()
        }
      }
    })()
    this.retirements.set(realmId, retirement)
    void retirement.then(
      () => { if (this.retirements.get(realmId) === retirement) this.retirements.delete(realmId) },
      () => { if (this.retirements.get(realmId) === retirement) this.retirements.delete(realmId) },
    )
  }

  /**
   * Stop admission, settle any ownership claim already in flight, then retire
   * every Realm. Each claim releases only after its worker has fully stopped.
   */
  private async teardown(): Promise<void> {
    this.disposed = true
    this.releaseAdmissionStop()
    await this.poolMutationTail

    for (const [realmId, realm] of [...this.pool]) this.reclaim(realmId, realm)
    await Promise.all([...this.retirements.values()])

    // Defensive cleanup for a claim that completed but never reached a pool
    // entry; normal admission and retirement leave this map empty here.
    const releases = [...this.realmLeases.values()]
    this.realmLeases.clear()
    await Promise.all(releases.map(release => release()))
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
