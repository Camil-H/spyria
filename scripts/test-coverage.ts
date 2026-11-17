import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type CoveredLines = Map<string, Set<number>>

const isTestSource = (file: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /\/(testing|e2e)\//.test(file)

export const areaOf = (file: string) => {
  const serverArea = /^apps\/server\/src\/([^/]+)\//.exec(file)
  if (serverArea) return `apps/server/src/${serverArea[1]}`
  if (file.startsWith('apps/server/src/')) return 'apps/server/src'
  const workspacePackage = /^(apps|packages)\/([^/]+)\//.exec(file)
  return workspacePackage ? `${workspacePackage[1]}/${workspacePackage[2]}` : (file.split('/')[0] ?? file)
}

export const coveredLinesOfLcov = (lcov: string): CoveredLines => {
  const covered: CoveredLines = new Map()
  let lines: Set<number> | undefined
  for (const record of lcov.split('\n')) {
    if (record.startsWith('SF:')) {
      const file = record.slice(3)
      lines = isTestSource(file) ? undefined : (covered.get(file) ?? covered.set(file, new Set()).get(file))
    } else if (lines && record.startsWith('DA:')) {
      const [line, hits] = record.slice(3).split(',').map(Number)
      if (line !== undefined && hits !== undefined && hits > 0) lines.add(line)
    }
  }
  return covered
}

const rangesOf = (lines: Set<number>) => {
  const ranges: string[] = []
  const sorted = [...lines].toSorted((first, second) => first - second)
  for (let start = 0; start < sorted.length; ) {
    let end = start
    while (sorted[end + 1] === (sorted[end] ?? 0) + 1) end++
    ranges.push(start === end ? `${sorted[start]}` : `${sorted[start]}-${sorted[end]}`)
    start = end + 1
  }
  return ranges.join(',')
}

export const formatCoveredLines = (covered: CoveredLines) =>
  `${[...covered]
    .filter(([, lines]) => lines.size > 0)
    .toSorted(([first], [second]) => first.localeCompare(second))
    .map(([file, lines]) => `${file}: ${rangesOf(lines)}`)
    .join('\n')}\n`

export const parseCoveredLines = (text: string): CoveredLines =>
  new Map(
    text
      .split('\n')
      .filter(Boolean)
      .map((record) => {
        const [file = '', ranges = ''] = record.split(': ')
        const lines = ranges.split(',').flatMap((range) => {
          const [start = 0, end = start] = range.split('-').map(Number)
          return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
        })
        return [file, new Set(lines)]
      }),
  )

const countByArea = (covered: CoveredLines) => {
  const counts = new Map<string, number>()
  for (const [file, lines] of covered) counts.set(areaOf(file), (counts.get(areaOf(file)) ?? 0) + lines.size)
  return counts
}

export const compareCoverage = (baseline: CoveredLines, current: CoveredLines) => {
  const lost = [...baseline].flatMap(([file, lines]) => {
    const missing = [...lines].filter((line) => !current.get(file)?.has(line))
    return missing.length > 0 ? [{ file, lines: new Set(missing) }] : []
  })
  const baselineByArea = countByArea(baseline)
  const currentByArea = countByArea(current)
  const areas = [...new Set([...baselineByArea.keys(), ...currentByArea.keys()])].toSorted()
  return {
    lost,
    areas: areas.map((area) => ({
      area,
      baseline: baselineByArea.get(area) ?? 0,
      current: currentByArea.get(area) ?? 0,
    })),
  }
}

const baselineFileOf = (layer: string) => new URL(`../tests/baseline/${layer}.coverage.txt`, import.meta.url).pathname

const run = (command: string | undefined, layer: string | undefined, lcovFile: string | undefined) => {
  if (!layer || !lcovFile || (command !== 'save' && command !== 'compare'))
    throw new Error('Usage: bun scripts/test-coverage.ts save|compare <layer> <lcov.info>')
  const current = coveredLinesOfLcov(readFileSync(lcovFile, 'utf8'))
  if (command === 'save') return writeFileSync(baselineFileOf(layer), formatCoveredLines(current))
  const baselineFile = baselineFileOf(layer)
  const baseline = existsSync(baselineFile) ? parseCoveredLines(readFileSync(baselineFile, 'utf8')) : new Map()
  const { lost, areas } = compareCoverage(baseline, current)
  console.log(`${layer} covered source lines, baseline → now:`)
  for (const { area, baseline: before, current: after } of areas)
    console.log(`  ${area.padEnd(40)} ${String(before).padStart(6)} → ${String(after).padStart(6)}`)
  for (const { file, lines } of lost) console.log(`lost: ${file}: ${rangesOf(lines)}`)
  process.exitCode = lost.length > 0 ? 1 : 0
}

if (import.meta.main) run(...(process.argv.slice(2) as [string, string, string]))
