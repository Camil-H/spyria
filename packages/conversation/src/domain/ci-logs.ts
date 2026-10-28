const timestampPrefix = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/
const colorCodes = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*[A-Za-z]`, 'g')
const errorMarker = '##[error]'
const stepStartMarker = '##[group]Run '
export const logExcerptLines = 100
export const logExcerptCharacters = 10_000

const cleanedLinesOf = (log: string) =>
  log
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.replace(timestampPrefix, '').replaceAll(colorCodes, ''))

const lastIndexWhere = (lines: string[], matches: (line: string) => boolean, before = lines.length) => {
  for (let index = before - 1; index >= 0; index -= 1) if (matches(lines[index] ?? '')) return index
  return -1
}

export const logExcerptOf = (log: string) => {
  const lines = cleanedLinesOf(log)
  const lastError = lastIndexWhere(lines, (line) => line.startsWith(errorMarker))
  const end = lastError === -1 ? lines.length : lastError + 1
  const stepStart = lastIndexWhere(lines, (line) => line.startsWith(stepStartMarker), end)
  const start = Math.max(stepStart, end - logExcerptLines, 0)
  const excerpt = lines
    .slice(start, end)
    .filter((line) => line !== '##[endgroup]')
    .map((line) => line.replace(/^##\[group\]/, '').replace(/^##\[error\]/, 'error: '))
    .join('\n')
    .trimEnd()
  return excerpt.length > logExcerptCharacters ? `[cut]\n${excerpt.slice(-logExcerptCharacters)}` : excerpt
}
