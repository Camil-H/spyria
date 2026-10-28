export type Snippet = Readonly<{ before: string; match: string; after: string }>

export const searchNeedleOf = (text: string) => text.trim().toLowerCase()

export const matchOffsetsIn = (haystack: string, needle: string) => {
  if (needle === '') return []
  const lowered = haystack.toLowerCase()
  const offsets: number[] = []
  for (let offset = lowered.indexOf(needle); offset !== -1; offset = lowered.indexOf(needle, offset + needle.length))
    offsets.push(offset)
  return offsets
}

const contextCharacters = 60

export const snippetOf = (body: string, needle: string): Snippet => {
  const flattened = body.replace(/\s+/g, ' ').trim()
  const offset = matchOffsetsIn(flattened, needle)[0]
  if (offset === undefined) return { before: '', match: '', after: flattened.slice(0, contextCharacters * 2) }
  const start = Math.max(0, offset - contextCharacters)
  const end = Math.min(flattened.length, offset + needle.length + contextCharacters)
  return {
    before: `${start > 0 ? '…' : ''}${flattened.slice(start, offset)}`,
    match: flattened.slice(offset, offset + needle.length),
    after: `${flattened.slice(offset + needle.length, end)}${end < flattened.length ? '…' : ''}`,
  }
}

export type TextSegment<Block> = Readonly<{ text: string; block: Block }>
export type SegmentPosition = Readonly<{ segment: number; offset: number }>

export const matchSpansIn = <Block>(segments: readonly TextSegment<Block>[], needle: string) => {
  let joined = ''
  const starts = segments.map((segment, index) => {
    if (index > 0 && segment.block !== segments[index - 1]?.block) joined += '\n'
    const start = joined.length
    joined += segment.text
    return start
  })
  const positionOf = (at: number, isEnd: boolean): SegmentPosition => {
    const segment = starts.findLastIndex((start) => (isEnd ? start < at : start <= at))
    return { segment, offset: at - (starts[segment] ?? 0) }
  }
  return matchOffsetsIn(joined, needle).map((offset) => ({
    start: positionOf(offset, false),
    end: positionOf(offset + needle.length, true),
  }))
}
