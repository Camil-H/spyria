import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { streamedBlocksOf } from '../domain/streamed-markdown.ts'

const markdownStyles = [
  'code',
  'emphasis',
  'heading',
  'link',
  'marker',
  'quote',
  'strike',
  'strong',
  'underline',
] as const
export type MarkdownStyle = (typeof markdownStyles)[number]
export type StyledRun = Readonly<{ start: number; text: string; styles: readonly MarkdownStyle[] }>

const maximumStyledLength = 4_000
const maximumCachedBlocks = 500
const bitOf = (style: MarkdownStyle) => 1 << markdownStyles.indexOf(style)
const stylesOf = (bits: number) => markdownStyles.filter((style) => bits & bitOf(style))

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

const styledBlockRunsOf = (text: string): StyledRun[] => {
  if (text.length > maximumStyledLength) return [{ start: 0, text, styles: [] }]
  const bits = new Uint16Array(text.length)
  const mark = (from: number, to: number, style: MarkdownStyle) => {
    for (let index = from; index < to; index++) bits[index] = (bits[index] ?? 0) | bitOf(style)
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
    if (index < text.length && bits[index - 1] === bits[index]) continue
    runs.push({ start: runStart, text: text.slice(runStart, index), styles: stylesOf(bits[index - 1] ?? 0) })
    runStart = index
  }
  return runs
}

const runsByBlock = new Map<string, StyledRun[]>()

const cachedBlockRunsOf = (text: string) => {
  const known = runsByBlock.get(text)
  if (known) return known
  if (runsByBlock.size >= maximumCachedBlocks) runsByBlock.clear()
  const runs = styledBlockRunsOf(text)
  runsByBlock.set(text, runs)
  return runs
}

const plainRun = (text: string, start: number, end: number): StyledRun[] =>
  end > start ? [{ start, text: text.slice(start, end), styles: [] }] : []

export const styledRunsOf = (text: string): StyledRun[] => {
  const { completed, tail } = streamedBlocksOf(text)
  const runs: StyledRun[] = []
  let cursor = 0
  for (const block of [...completed, tail]) {
    runs.push(...plainRun(text, cursor, block.offset))
    for (const run of cachedBlockRunsOf(block.text)) runs.push({ ...run, start: run.start + block.offset })
    cursor = block.offset + block.text.length
  }
  return [...runs, ...plainRun(text, cursor, text.length)]
}
