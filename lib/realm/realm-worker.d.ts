/**
 * Long-lived realm worker: one V8 isolate per realm generation that owns a
 * `state` namespace surviving across runs, executes at most one program at a
 * time, and leases binding members only for the duration of the run that
 * declared them.
 *
 * This module boots as a bare Node worker — no bundler, no path aliases, an
 * empty environment and `execArgv: []` — so it may only import Node builtins
 * and TYPE-ONLY declarations. Intrinsics are captured at load, before any model
 * code can reassign a global.
 * @module dsh-prime-agent/realm/realm-worker
 */
export {};
//# sourceMappingURL=realm-worker.d.ts.map