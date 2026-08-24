// Deterministic completion-value fixtures sized to a target JSON byte budget.
// Every shape is built from a fixed seed so repeated runs produce identical
// values, identical JSON bytes and identical node counts.

const MIB = 1024 * 1024

/** Deterministic 32-bit PRNG (mulberry32); no Math.random anywhere in bench. */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
]

/** Array of 9-digit integers: ~10 JSON bytes per element, 1 node per element. */
function flatNumberArray(targetBytes) {
  const next = rng(1)
  const count = Math.max(1, Math.floor(targetBytes / 10))
  const items = new Array(count)
  for (let index = 0; index < count; index++) items[index] = 100000000 + Math.floor(next() * 899999999)
  return items
}

/** Array of small records: ~66 JSON bytes per record, 5 nodes per record. */
function recordArray(targetBytes) {
  const next = rng(2)
  const count = Math.max(1, Math.floor(targetBytes / 66))
  const items = new Array(count)
  for (let index = 0; index < count; index++) {
    items[index] = {
      id: 100000000 + index,
      name: `${WORDS[index % WORDS.length]}-${(index % 100000).toString().padStart(5, '0')}`,
      score: Math.floor(next() * 1000000),
      ok: (index & 1) === 0,
    }
  }
  return items
}

/** Flat object with many short keys: ~24 JSON bytes per entry, 1 node per entry. */
function wideObject(targetBytes) {
  const next = rng(3)
  const count = Math.max(1, Math.floor(targetBytes / 24))
  const target = {}
  for (let index = 0; index < count; index++) {
    target[`k${index.toString(36).padStart(6, '0')}`] = 100000000 + Math.floor(next() * 899999999)
  }
  return target
}

/** One long ASCII string: 1 JSON byte per character, 1 node total. */
function longString(targetBytes) {
  const unit = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const length = Math.max(1, targetBytes - 2)
  let text = ''
  while (text.length < length) text += unit
  return text.slice(0, length)
}

/**
 * Deep left-spine nesting `{v:{v:{...,leaf:[...]}}}`. `depth` is bounded well
 * below the snapshotValue recursion limit; the remaining budget goes into the
 * leaf arrays so the shape can reach any target size.
 */
function deepNested(targetBytes, depth = 1000) {
  const perLevel = Math.max(0, Math.floor((targetBytes - depth * 6) / depth))
  let node = { leaf: flatNumberArray(perLevel) }
  for (let level = 1; level < depth; level++) node = { v: node, leaf: flatNumberArray(perLevel) }
  return node
}

/**
 * A DAG: `fanout` sibling slots all pointing at the SAME sub-object, repeated
 * over `levels`. Live heap is tiny; snapshotValue expands every path (its `seen`
 * set is a path set that deletes on exit, realm-worker.ts:674), so the snapshot
 * and the JSON are fanout**levels times larger than the live object graph.
 */
function sharedDag({ leafBytes, fanout, levels }) {
  let node = { payload: flatNumberArray(leafBytes) }
  for (let level = 0; level < levels; level++) {
    const parent = {}
    for (let slot = 0; slot < fanout; slot++) parent[`s${slot}`] = node
    node = parent
  }
  return node
}

/** A value whose live heap and snapshot size agree, for the retention benchmarks. */
export function buildFixture(shape, mib) {
  const targetBytes = Math.round(mib * MIB)
  switch (shape) {
    case 'flat-array': return flatNumberArray(targetBytes)
    case 'record-array': return recordArray(targetBytes)
    case 'wide-object': return wideObject(targetBytes)
    case 'long-string': return longString(targetBytes)
    case 'deep-nested': return deepNested(targetBytes)
    default: throw new Error(`unknown shape: ${shape}`)
  }
}

export const SHAPES = ['flat-array', 'record-array', 'wide-object', 'long-string', 'deep-nested']
export { sharedDag, flatNumberArray, MIB }
