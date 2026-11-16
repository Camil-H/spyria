import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

export type MarkdownStyle =
  | 'marker'
  | 'strong'
  | 'emphasis'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link'
  | 'heading'
  | 'quote'
export type StyledRun = Readonly<{ start: number; text: string; styles: readonly MarkdownStyle[] }>

const styleOfNode: Partial<Record<Nodes['type'], MarkdownStyle>> = {
  strong: 'strong',
  emphasis: 'emphasis',
  delete: 'strike',
  inlineCode: 'code',
  code: 'code',
  link: 'link',
  heading: 'heading',
  blockquote: 'quote',
}
const nodesWithMarkers = new Set<Nodes['type']>([
  'strong',
  'emphasis',
  'delete',
  'link',
  'image',
  'heading',
  'blockquote',
  'listItem',
  'thematicBreak',
])
const fencePattern = /^ {0,3}(`{3,}|~{3,})/

const keyOf = (styles: ReadonlySet<MarkdownStyle> | undefined) => [...(styles ?? [])].sort().join()

export const styledRunsOf = (text: string): StyledRun[] => {
  const styles = Array.from({ length: text.length }, () => new Set<MarkdownStyle>())
  const mark = (from: number, to: number, style: MarkdownStyle) => {
    for (let index = from; index < to; index++) styles[index]?.add(style)
  }
  const markFences = (start: number, end: number) => {
    if (!fencePattern.test(text.slice(start, end))) return
    const firstLineEnd = text.indexOf('\n', start)
    mark(start, firstLineEnd === -1 || firstLineEnd > end ? end : firstLineEnd, 'marker')
    const lastLineStart = text.lastIndexOf('\n', end - 1) + 1
    if (lastLineStart > start && fencePattern.test(text.slice(lastLineStart, end))) mark(lastLineStart, end, 'marker')
  }
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    const style = node.type === 'strong' && text.startsWith('__', start) ? 'underline' : styleOfNode[node.type]
    if (style) mark(start, end, style)
    if (node.type === 'inlineCode') {
      const ticks = /^`+/.exec(text.slice(start, end))?.[0].length ?? 0
      mark(start, start + ticks, 'marker')
      mark(end - ticks, end, 'marker')
    }
    if (node.type === 'code') markFences(start, end)
    const children = 'children' in node ? node.children : []
    if (nodesWithMarkers.has(node.type)) {
      let cursor = start
      for (const child of children) {
        mark(cursor, child.position?.start.offset ?? cursor, 'marker')
        cursor = child.position?.end.offset ?? cursor
      }
      mark(cursor, end, 'marker')
    }
    children.forEach(visit)
  }
  visit(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))
  const runs: StyledRun[] = []
  let runStart = 0
  for (let index = 1; index <= text.length; index++) {
    if (index < text.length && keyOf(styles[index - 1]) === keyOf(styles[index])) continue
    runs.push({ start: runStart, text: text.slice(runStart, index), styles: [...(styles[index - 1] ?? [])].sort() })
    runStart = index
  }
  return runs
}
