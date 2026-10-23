export type TextSelection = Readonly<{ text: string; start: number; end: number }>
export type TextEdit = Readonly<{ start: number; end: number; insert: string; selectStart: number; selectEnd: number }>
export type Formatting = 'bold' | 'italic' | 'underline' | 'code' | 'link'
export type FormattingKey = Readonly<{ key: string; isPrimary: boolean; isShift: boolean; isOtherModifier: boolean }>

const markerOf = { bold: '**', italic: '*', underline: '__' } as const
const urlPattern = /^https?:\/\/\S+$/
const listItemPattern = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))\s+(\[[ xX]\]\s+)?/
const linkPlaceholder = 'url'

const withoutSurroundingSpaces = ({ text, start, end }: TextSelection): TextSelection => {
  const selected = text.slice(start, end)
  const leading = selected.length - selected.trimStart().length
  const trailing = selected.trim() === '' ? 0 : selected.length - selected.trimEnd().length
  return { text, start: start + leading, end: end - trailing }
}

const isOpeningAt = (text: string, index: number, marker: string) =>
  text.startsWith(marker, index) && text[index - 1] !== marker[0]
const isClosingAt = (text: string, index: number, marker: string) =>
  text.startsWith(marker, index) && text[index + marker.length] !== marker[0]
const isWholeMarkerAt = (text: string, index: number, marker: string) =>
  isOpeningAt(text, index, marker) && isClosingAt(text, index, marker)

const toggledMarker = (selection: TextSelection, marker: string): TextEdit => {
  const { text, start, end } = withoutSurroundingSpaces(selection)
  const selected = text.slice(start, end)
  const size = marker.length
  const isSelectedWithMarkers =
    selected.length > 2 * size &&
    isWholeMarkerAt(selected, 0, marker) &&
    isWholeMarkerAt(selected, selected.length - size, marker)
  if (isSelectedWithMarkers)
    return { start, end, insert: selected.slice(size, -size), selectStart: start, selectEnd: end - 2 * size }
  if (isOpeningAt(text, start - size, marker) && isClosingAt(text, end, marker))
    return { start: start - size, end: end + size, insert: selected, selectStart: start - size, selectEnd: end - size }
  return { start, end, insert: `${marker}${selected}${marker}`, selectStart: start + size, selectEnd: end + size }
}

const codeOf = (selection: TextSelection): TextEdit => {
  const { text, start, end } = selection
  const selected = text.slice(start, end)
  if (!selected.includes('\n')) return toggledMarker(selection, '`')
  const opening = `${start > 0 && text[start - 1] !== '\n' ? '\n' : ''}\`\`\`\n`
  const closing = `\n\`\`\`${end < text.length && text[end] !== '\n' ? '\n' : ''}`
  const selectStart = start + opening.length
  return {
    start,
    end,
    insert: `${opening}${selected}${closing}`,
    selectStart,
    selectEnd: selectStart + selected.length,
  }
}

const linkOf = (selection: TextSelection): TextEdit => {
  const { text, start, end } = withoutSurroundingSpaces(selection)
  const selected = text.slice(start, end)
  if (urlPattern.test(selected))
    return { start, end, insert: `[](${selected})`, selectStart: start + 1, selectEnd: start + 1 }
  const selectStart = start + selected.length + 3
  return {
    start,
    end,
    insert: `[${selected}](${linkPlaceholder})`,
    selectStart,
    selectEnd: selectStart + linkPlaceholder.length,
  }
}

export const formattedText = (selection: TextSelection, formatting: Formatting): TextEdit =>
  formatting === 'code'
    ? codeOf(selection)
    : formatting === 'link'
      ? linkOf(selection)
      : toggledMarker(selection, markerOf[formatting])

export const formattingOfKey = ({
  key,
  isPrimary,
  isShift,
  isOtherModifier,
}: FormattingKey): Formatting | undefined => {
  if (!isPrimary || isOtherModifier) return undefined
  const letter = key.toLowerCase()
  if (isShift) return letter === 'c' ? 'code' : undefined
  return letter === 'b'
    ? 'bold'
    : letter === 'i'
      ? 'italic'
      : letter === 'u'
        ? 'underline'
        : letter === 'k'
          ? 'link'
          : undefined
}

export const linkedPaste = ({ text, start, end }: TextSelection, pasted: string): TextEdit | undefined => {
  const selected = text.slice(start, end)
  const url = pasted.trim()
  if (selected.trim() === '' || selected.includes('\n') || urlPattern.test(selected) || !urlPattern.test(url))
    return undefined
  const insert = `[${selected}](${url})`
  return { start, end, insert, selectStart: start + insert.length, selectEnd: start + insert.length }
}

export const continuedList = ({ text, start, end }: TextSelection): TextEdit | undefined => {
  if (start !== end) return undefined
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const lineEnd = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start)
  const match = listItemPattern.exec(text.slice(lineStart, start))
  if (!match) return undefined
  const [marker = '', indent = '', bullet, number, delimiter, task] = match
  if (text.slice(lineStart, lineEnd).trim() === marker.trim())
    return { start: lineStart, end: lineEnd, insert: '', selectStart: lineStart, selectEnd: lineStart }
  const next = `\n${indent}${bullet ?? `${Number(number) + 1}${delimiter}`} ${task ? '[ ] ' : ''}`
  return { start, end, insert: next, selectStart: start + next.length, selectEnd: start + next.length }
}
