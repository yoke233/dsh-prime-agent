// Replica of the boundary snapshot path measured by these benchmarks.
//
// Source: src/realm/realm-worker.ts
//   - captured primitives   lines 25-59
//   - snapshotJson          lines 634-636
//   - snapshotValue         lines 638-676
//   - prepareCompletion     lines 693-703
//
// The replica keeps the captured-primitive / Reflect.apply indirection of the
// original, because that indirection is part of the CPU cost being measured.
// It is imported by the bench scripts only; src/ and lib/ are untouched.

const CapturedError = Error
const CapturedSet = Set
const capturedArrayPush = Array.prototype.push
const capturedArrayIsArray = Array.isArray
const capturedBufferByteLength = Buffer.byteLength
const capturedJsonStringify = JSON.stringify
const capturedNumberIsFinite = Number.isFinite
const capturedObjectCreate = Object.create
const capturedObjectGetPrototypeOf = Object.getPrototypeOf
const capturedObjectHasOwn = Object.hasOwn
const capturedObjectIs = Object.is
const capturedObjectPrototype = Object.prototype
const capturedPropertyIsEnumerable = Object.prototype.propertyIsEnumerable
const capturedReflectApply = Reflect.apply
const capturedReflectOwnKeys = Reflect.ownKeys
const capturedSetAdd = Set.prototype.add
const capturedSetDelete = Set.prototype.delete
const capturedSetHas = Set.prototype.has

/** Faithful replica of realm-worker.ts snapshotValue (lines 638-676). */
export function snapshotValue(value, seen) {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'boolean' || kind === 'string') return value
  if (kind === 'number') {
    if (!capturedNumberIsFinite(value) || capturedObjectIs(value, -0)) throw new CapturedError('value is not lossless JSON')
    return value
  }
  if (kind !== 'object') throw new CapturedError('value is not lossless JSON')
  const source = value
  if (capturedReflectApply(capturedSetHas, seen, [source])) throw new CapturedError('value is not lossless JSON')
  capturedReflectApply(capturedSetAdd, seen, [source])
  let snapshot
  if (capturedArrayIsArray(source)) {
    const items = source
    if (capturedReflectOwnKeys(items).length !== items.length + 1) throw new CapturedError('value is not lossless JSON')
    const target = []
    for (let index = 0; index < items.length; index++) {
      if (!capturedObjectHasOwn(items, index)) throw new CapturedError('value is not lossless JSON')
      capturedReflectApply(capturedArrayPush, target, [snapshotValue(items[index], seen)])
    }
    snapshot = target
  } else {
    const prototype = capturedObjectGetPrototypeOf(source)
    if (prototype !== null && prototype !== capturedObjectPrototype) throw new CapturedError('value is not lossless JSON')
    const target = capturedObjectCreate(null)
    const keys = capturedReflectOwnKeys(source)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (typeof key !== 'string' || !capturedReflectApply(capturedPropertyIsEnumerable, source, [key])) {
        throw new CapturedError('value is not lossless JSON')
      }
      target[key] = snapshotValue(source[key], seen)
    }
    snapshot = target
  }
  capturedReflectApply(capturedSetDelete, seen, [source])
  return snapshot
}

export function snapshotJson(value) {
  return snapshotValue(value, new CapturedSet())
}

/**
 * snapshotValue with an added node counter, matching the plan's
 * "count nodes in the same bounded traversal" requirement (plan §7.1 step 2).
 * `counter` is a one-element Int32Array-like box so the increment cost is a
 * real memory write rather than a closure allocation per call.
 */
export function snapshotValueCounting(value, seen, counter) {
  counter.nodes++
  if (value === null) return null
  const kind = typeof value
  if (kind === 'boolean' || kind === 'string') return value
  if (kind === 'number') {
    if (!capturedNumberIsFinite(value) || capturedObjectIs(value, -0)) throw new CapturedError('value is not lossless JSON')
    return value
  }
  if (kind !== 'object') throw new CapturedError('value is not lossless JSON')
  const source = value
  if (capturedReflectApply(capturedSetHas, seen, [source])) throw new CapturedError('value is not lossless JSON')
  capturedReflectApply(capturedSetAdd, seen, [source])
  let snapshot
  if (capturedArrayIsArray(source)) {
    const items = source
    if (capturedReflectOwnKeys(items).length !== items.length + 1) throw new CapturedError('value is not lossless JSON')
    const target = []
    for (let index = 0; index < items.length; index++) {
      if (!capturedObjectHasOwn(items, index)) throw new CapturedError('value is not lossless JSON')
      capturedReflectApply(capturedArrayPush, target, [snapshotValueCounting(items[index], seen, counter)])
    }
    snapshot = target
  } else {
    const prototype = capturedObjectGetPrototypeOf(source)
    if (prototype !== null && prototype !== capturedObjectPrototype) throw new CapturedError('value is not lossless JSON')
    const target = capturedObjectCreate(null)
    const keys = capturedReflectOwnKeys(source)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (typeof key !== 'string' || !capturedReflectApply(capturedPropertyIsEnumerable, source, [key])) {
        throw new CapturedError('value is not lossless JSON')
      }
      target[key] = snapshotValueCounting(source[key], seen, counter)
    }
    snapshot = target
  }
  capturedReflectApply(capturedSetDelete, seen, [source])
  return snapshot
}

export function snapshotJsonCounting(value) {
  const counter = { nodes: 0 }
  const snapshot = snapshotValueCounting(value, new CapturedSet(), counter)
  return { snapshot, nodes: counter.nodes }
}

export function utf8Bytes(text) {
  return capturedBufferByteLength(text, 'utf8')
}

export function stringify(value) {
  return capturedJsonStringify(value)
}
