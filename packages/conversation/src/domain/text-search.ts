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
