export type DiffLine = { kind: 'added' | 'removed' | 'context' | 'gap'; text: string }
type EditKind = Exclude<DiffLine['kind'], 'gap'>

const contextLines = 3
const maximumEditDistance = 1000

const internedLinesOf = (before: readonly string[], after: readonly string[]) => {
  const idByLine = new Map<string, number>()
  const idOf = (line: string) => {
    const known = idByLine.get(line)
    if (known !== undefined) return known
    idByLine.set(line, idByLine.size)
    return idByLine.size - 1
  }
  return { beforeIds: Int32Array.from(before, idOf), afterIds: Int32Array.from(after, idOf) }
}

const isInsertionAt = (furthest: Int32Array, center: number, diagonal: number, distance: number) =>
  diagonal === -distance ||
  (diagonal !== distance && (furthest[center + diagonal - 1] ?? 0) < (furthest[center + diagonal + 1] ?? 0))

const editPathOf = (furthestByDistance: Int32Array[], beforeCount: number, afterCount: number) => {
  const reversed: EditKind[] = []
  let x = beforeCount
  let y = afterCount
  for (let distance = furthestByDistance.length - 1; distance > 0; distance--) {
    const furthest = furthestByDistance[distance] as Int32Array
    const diagonal = x - y
    const isInsertion = isInsertionAt(furthest, distance, diagonal, distance)
    const previousDiagonal = isInsertion ? diagonal + 1 : diagonal - 1
    const previousX = furthest[distance + previousDiagonal] ?? 0
    for (; x > previousX && y > previousX - previousDiagonal; y--, x--) reversed.push('context')
    reversed.push(isInsertion ? 'added' : 'removed')
    if (isInsertion) y--
    else x--
  }
  for (; x > 0; x--) reversed.push('context')
  return reversed.reverse()
}

const shortestEditOf = (before: readonly string[], after: readonly string[]) => {
  const { beforeIds, afterIds } = internedLinesOf(before, after)
  const center = beforeIds.length + afterIds.length + 1
  const furthest = new Int32Array(2 * center + 1)
  const furthestByDistance: Int32Array[] = []
  const lastDistance = Math.min(beforeIds.length + afterIds.length, maximumEditDistance)
  for (let distance = 0; distance <= lastDistance; distance++) {
    furthestByDistance.push(furthest.slice(center - distance, center + distance + 1))
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x = isInsertionAt(furthest, center, diagonal, distance)
        ? (furthest[center + diagonal + 1] ?? 0)
        : (furthest[center + diagonal - 1] ?? 0) + 1
      let y = x - diagonal
      for (; x < beforeIds.length && y < afterIds.length && beforeIds[x] === afterIds[y]; y++) x++
      furthest[center + diagonal] = x
      if (x >= beforeIds.length && y >= afterIds.length)
        return editPathOf(furthestByDistance, beforeIds.length, afterIds.length)
    }
  }
  return undefined
}

const removalsFirst = (kinds: readonly EditKind[]) => {
  const ordered: EditKind[] = []
  let pendingAdditions = 0
  for (const kind of kinds) {
    if (kind === 'added') pendingAdditions++
    else if (kind === 'removed') ordered.push(kind)
    else {
      for (; pendingAdditions > 0; pendingAdditions--) ordered.push('added')
      ordered.push(kind)
    }
  }
  for (; pendingAdditions > 0; pendingAdditions--) ordered.push('added')
  return ordered
}

const hunksOf = (kinds: readonly EditKind[], before: readonly string[], after: readonly string[]) => {
  const nextChangeAt = new Int32Array(kinds.length)
  let nextChange = kinds.length + contextLines + 1
  for (let index = kinds.length - 1; index >= 0; index--) {
    if (kinds[index] !== 'context') nextChange = index
    nextChangeAt[index] = nextChange
  }
  const lines: DiffLine[] = []
  let previousChange = -contextLines - 1
  let beforeIndex = 0
  let afterIndex = 0
  let isSkipping = false
  for (const [index, kind] of kinds.entries()) {
    if (kind === 'added') lines.push({ kind, text: after[afterIndex++] as string })
    else if (kind === 'removed') lines.push({ kind, text: before[beforeIndex++] as string })
    if (kind !== 'context') {
      previousChange = index
      continue
    }
    const text = before[beforeIndex++] as string
    afterIndex++
    const nextChange = nextChangeAt[index] ?? 0
    const hidesOneLineOnly = previousChange >= 0 && nextChange - previousChange - 1 <= 2 * contextLines + 1
    if (index - previousChange > contextLines && nextChange - index > contextLines && !hidesOneLineOnly) {
      isSkipping = true
      continue
    }
    if (isSkipping && lines.length > 0) lines.push({ kind: 'gap', text: '' })
    isSkipping = false
    lines.push({ kind, text })
  }
  return lines
}

const repeated = (kind: EditKind, count: number): EditKind[] => Array(count).fill(kind)

export const lineDiffOf = (before: readonly string[], after: readonly string[]): DiffLine[] => {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++
  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)
  const changed = (removed.length > 0 && added.length > 0 && shortestEditOf(removed, added)) || [
    ...repeated('removed', removed.length),
    ...repeated('added', added.length),
  ]
  return hunksOf(
    [...repeated('context', prefix), ...removalsFirst(changed), ...repeated('context', suffix)],
    before,
    after,
  )
}
