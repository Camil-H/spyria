export type MentionQuery = Readonly<{ start: number; query: string }>
export type TextSegment = Readonly<{ text: string; isMention: boolean }>

const maximumQueryLength = 40
const candidatesShown = 6
const boundaryBefore = /[\s([{"'“‘]/
const nameCharacter = /[\p{L}\p{N}_-]/u

const isMentionStart = (text: string, index: number) => index === 0 || boundaryBefore.test(text[index - 1] ?? '')

export const mentionQueryAt = (text: string, caret: number): MentionQuery | undefined => {
  const start = text.lastIndexOf('@', caret - 1)
  if (start === -1 || caret - start - 1 > maximumQueryLength || !isMentionStart(text, start)) return undefined
  const query = text.slice(start + 1, caret)
  return /[\n@]/.test(query) || query.startsWith(' ') ? undefined : { start, query }
}

export const mentionCandidatesOf = (names: readonly string[], query: string) => {
  const needle = query.toLocaleLowerCase()
  const rankOf = (name: string) => {
    const lowerName = name.toLocaleLowerCase()
    if (lowerName.startsWith(needle)) return 0
    return lowerName.split(/\s+/).some((word) => word.startsWith(needle)) ? 1 : undefined
  }
  return [...new Set(names)]
    .flatMap((name) => {
      const rank = rankOf(name)
      return rank === undefined ? [] : [{ name, rank }]
    })
    .sort((first, second) => first.rank - second.rank || first.name.localeCompare(second.name))
    .slice(0, candidatesShown)
    .map(({ name }) => name)
}

export const mentionTextOf = (name: string) => `@${name} `

export const mentionSegmentsOf = (text: string, names: readonly string[]): TextSegment[] => {
  const lowerText = text.toLocaleLowerCase()
  const longestFirst = [...new Set(names)]
    .filter((name) => name !== '')
    .sort((first, second) => second.length - first.length)
  const segments: TextSegment[] = []
  let plainStart = 0
  for (let index = text.indexOf('@'); index !== -1; index = text.indexOf('@', index + 1)) {
    if (index < plainStart || !isMentionStart(text, index)) continue
    const name = longestFirst.find(
      (candidate) =>
        lowerText.startsWith(candidate.toLocaleLowerCase(), index + 1) &&
        !nameCharacter.test(text[index + 1 + candidate.length] ?? ''),
    )
    if (!name) continue
    if (index > plainStart) segments.push({ text: text.slice(plainStart, index), isMention: false })
    plainStart = index + 1 + name.length
    segments.push({ text: text.slice(index, plainStart), isMention: true })
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), isMention: false })
  return segments
}
