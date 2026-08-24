// Cell programs that build each benchmark shape INSIDE the realm worker.
//
// The Phase 0 bench built fixtures in the bench process and measured a replica
// of the boundary walk. The G1 exit gate measures the REAL path, so the value
// has to be a real cell completion living in a real Prime Realm namespace.
//
// Every shape is built once into `v` by a setup cell whose own completion is
// tiny, so the measured cell (`v`) pays only the boundary cost: capture walk,
// projection, wire, ledger. Generation cost is excluded by construction.
//
// Per-element JSON byte constants match bench/lib/fixtures.mjs so sizes stay
// comparable with the Phase 0 tables.

/** Deterministic integer sequence, inlined so the worker needs no imports. */
const RANDOM = 'const rnd = (i) => 100000000 + ((Math.imul(i ^ 0x9e3779b9, 2654435761) >>> 0) % 899999999)'

const BUILDERS = {
  'flat-array': {
    bytesPerElement: 10,
    build: (count) => `${RANDOM}
const v = new Array(${count})
for (let i = 0; i < ${count}; i++) v[i] = rnd(i)`,
  },
  'record-array': {
    bytesPerElement: 66,
    build: (count) => `${RANDOM}
const words = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa']
const v = new Array(${count})
for (let i = 0; i < ${count}; i++) v[i] = {
  id: 100000000 + i,
  name: words[i % 16] + '-' + String(i % 100000).padStart(5, '0'),
  score: rnd(i) % 1000000,
  ok: (i & 1) === 0,
}`,
  },
  'wide-object': {
    bytesPerElement: 24,
    build: (count) => `${RANDOM}
const v = {}
for (let i = 0; i < ${count}; i++) v['k' + i.toString(36).padStart(6, '0')] = rnd(i)`,
  },
  'deep-nested': {
    bytesPerElement: 10,
    // Depth 1000 left spine, the rest of the budget spread across leaf arrays.
    build: (count) => `${RANDOM}
const depth = 1000
const perLevel = Math.max(1, Math.floor(${count} / depth))
const leaf = (seed) => { const a = new Array(perLevel); for (let i = 0; i < perLevel; i++) a[i] = rnd(seed + i); return a }
let node = { leaf: leaf(0) }
for (let level = 1; level < depth; level++) node = { v: node, leaf: leaf(level * perLevel) }
const v = node`,
  },
  // The same big array, moved one level down under a single-key root. The root
  // enumeration is now 1 key, so anything that still scales with element count
  // is NOT the root own-keys enumeration G1 exempts — it is a per-array cost
  // paid at whatever depth the array sits.
  'wrapped-array': {
    bytesPerElement: 10,
    build: (count) => `${RANDOM}
const inner = new Array(${count})
for (let i = 0; i < ${count}; i++) inner[i] = rnd(i)
const v = { data: inner }`,
  },
  // One array of many SHORT arrays: same element total, but no single array
  // longer than the node ceiling. If cost tracks the longest single array
  // rather than the total, this stays cheap while wrapped-array does not.
  'chunked-array': {
    bytesPerElement: 10,
    build: (count) => `${RANDOM}
const chunk = 1000
const outer = new Array(Math.ceil(${count} / chunk))
for (let c = 0; c < outer.length; c++) {
  const a = new Array(chunk)
  for (let i = 0; i < chunk; i++) a[i] = rnd(c * chunk + i)
  outer[c] = a
}
const v = outer`,
  },
  // The same big string, wrapped in an object. A CDP RemoteObject carries a
  // PRIMITIVE completion inline by value but hands back only an objectId for an
  // object, so if wrapping collapses the cost, the cost was the Inspector
  // round-trip and not the capture walk.
  'wrapped-string': {
    bytesPerElement: 1,
    build: (count) => `const v = { s: 'abcdefghij'.repeat(Math.ceil(${count} / 10)).slice(0, ${count}) }`,
  },
  // Built with String.prototype.repeat, which yields a flat sequential string.
  'long-string': {
    bytesPerElement: 1,
    build: (count) => `const v = 'abcdefghij'.repeat(Math.ceil(${count} / 10)).slice(0, ${count})`,
  },
  // Same size and contents, built by doubling so V8 holds it as a cons/sliced
  // rope. Whoever first touches its characters pays the flattening. Kept as a
  // separate shape so a flattening cost cannot be misread as capture cost.
  'long-string-rope': {
    bytesPerElement: 1,
    build: (count) => `let s = 'abcdefghij'
while (s.length < ${count}) s += s
const v = s.slice(0, ${count})`,
  },
}

export const SHAPES = Object.keys(BUILDERS)

/** The setup cell: build `v`, return something tiny so setup is not measured. */
export function setupProgram(shape, mib) {
  const spec = BUILDERS[shape]
  if (!spec) throw new Error(`unknown shape: ${shape}`)
  const count = Math.max(1, Math.floor((mib * 1024 * 1024) / spec.bytesPerElement))
  return `${spec.build(count)}
globalThis.__v = v
'built'`
}

/** The measured cell: `v` as the completion value, nothing else. */
export const MEASURE_PROGRAM = 'globalThis.__v'

/**
 * Control cells: exactly ONE root enumeration over the same value, discarding
 * the result. Timing these in the same worker gives the single-enumeration
 * floor G1 exempts, measured in situ rather than quoted from Phase 0.
 *
 * Two variants because they are not interchangeable. The capture walk calls
 * `capturedReflectOwnKeys` (realm-worker.ts:918), and Phase 0 measured
 * `Reflect.ownKeys` at 1952 ms against `Object.keys` at 857 ms on the same
 * 64 MiB wide-object — 2.3x apart. Comparing the walk against the `Object.keys`
 * floor would understate the floor it actually pays, so the ownKeys control is
 * the one the verdict uses; the Object.keys control is kept for continuity with
 * the Phase 0 table.
 *
 * Both are guarded to object values. `Object.keys` on a 64 MiB STRING would
 * materialize 67 million index keys and take the worker out of memory — the
 * control would be measuring the harness, not the implementation.
 */
export const ENUMERATE_ONCE_PROGRAM =
  'typeof globalThis.__v === "object" && globalThis.__v !== null ? Object.keys(globalThis.__v).length : -1'
export const OWN_KEYS_ONCE_PROGRAM =
  'typeof globalThis.__v === "object" && globalThis.__v !== null ? Reflect.ownKeys(globalThis.__v).length : -1'

/**
 * Control cell: touch the completion's characters WITHOUT going through the
 * boundary, so a rope-flattening cost shows up here rather than being charged
 * to the capture walk.
 */
export const TOUCH_STRING_PROGRAM =
  'typeof globalThis.__v === "string" ? globalThis.__v.charCodeAt(globalThis.__v.length - 1) : -1'

/** Control cell: run overhead with no completion value at all. */
export const EMPTY_PROGRAM = 'undefined'
