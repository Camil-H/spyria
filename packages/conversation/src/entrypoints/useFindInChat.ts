import type { MessageId } from '@spyria/kernel'
import { useEffect, useRef, useState } from 'react'
import { matchSpansIn, searchNeedleOf } from '../domain/text-search.ts'

export const findRequestKey = 'findInChat'
export type FindRequest = Readonly<{ text: string; messageId: MessageId | null }>

const matchHighlightName = 'find-match'
const currentHighlightName = 'find-current'
const supportsHighlights = () => typeof CSS !== 'undefined' && 'highlights' in CSS
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const blockSelector = 'p, li, pre, td, th, h1, h2, h3, h4, h5, h6, blockquote, div, button, time'

const textNodesIn = (root: HTMLElement) => {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node instanceof Text && node.data !== '') nodes.push(node)
  return nodes
}

const rangesIn = (root: HTMLElement, needle: string) => {
  const nodes = textNodesIn(root)
  const segments = nodes.map((node) => ({ text: node.data, block: node.parentElement?.closest(blockSelector) }))
  return matchSpansIn(segments, needle).flatMap(({ start, end }) => {
    const startNode = nodes[start.segment]
    const endNode = nodes[end.segment]
    if (!startNode || !endNode) return []
    const range = document.createRange()
    range.setStart(startNode, start.offset)
    range.setEnd(endNode, end.offset)
    return [range]
  })
}

const scrollToRange = (range: Range | undefined) =>
  range?.startContainer.parentElement?.scrollIntoView({
    block: 'center',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  })

const isInMessage = (range: Range, messageId: MessageId) =>
  range.startContainer.parentElement?.closest(`[data-message-id="${CSS.escape(messageId)}"]`) != null

const useMatchRanges = (root: HTMLElement | null, needle: string) => {
  const [ranges, setRanges] = useState<readonly Range[]>([])
  useEffect(() => {
    if (!root || needle === '') return setRanges([])
    let frame = 0
    const scan = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setRanges(rangesIn(root, needle)))
    }
    scan()
    const observer = new MutationObserver(scan)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [root, needle])
  return ranges
}

export const useFindInChat = (root: HTMLElement | null, text: string, targetMessageId: MessageId | null) => {
  const needle = searchNeedleOf(text)
  const ranges = useMatchRanges(root, needle)
  const [chosen, setChosen] = useState<{ needle: string; index: number } | null>(null)
  const targetIndex = targetMessageId ? ranges.findIndex((range) => isInMessage(range, targetMessageId)) : -1
  const defaultIndex = targetIndex >= 0 ? targetIndex : ranges.length - 1
  const index = chosen?.needle === needle ? Math.min(chosen.index, ranges.length - 1) : defaultIndex
  const scrolledFor = useRef('')
  useEffect(() => {
    const scrollKey = `${needle}\n${targetIndex >= 0}`
    if (ranges.length === 0 || scrolledFor.current === scrollKey || chosen?.needle === needle) return
    scrolledFor.current = scrollKey
    scrollToRange(ranges[index])
  }, [needle, ranges, index, targetIndex, chosen])
  useEffect(() => {
    if (!supportsHighlights()) return
    const current = ranges[index]
    CSS.highlights.set(matchHighlightName, new Highlight(...ranges))
    if (current) CSS.highlights.set(currentHighlightName, new Highlight(current))
    return () => {
      CSS.highlights.delete(matchHighlightName)
      CSS.highlights.delete(currentHighlightName)
    }
  }, [ranges, index])
  const moveBy = (step: number) => {
    if (ranges.length === 0) return
    const nextIndex = (index + step + ranges.length) % ranges.length
    setChosen({ needle, index: nextIndex })
    scrollToRange(ranges[nextIndex])
  }
  return {
    count: ranges.length,
    position: index + 1,
    next: () => moveBy(1),
    previous: () => moveBy(-1),
  }
}
