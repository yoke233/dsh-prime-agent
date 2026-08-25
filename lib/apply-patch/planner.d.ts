import { type ParsedPatch, type PatchPlan } from './types.js';
/** Compute every final file body without performing any mutation. */
export declare function planPatch(parsed: ParsedPatch, snapshots: ReadonlyMap<string, string | null>): PatchPlan;
//# sourceMappingURL=planner.d.ts.map