import type { MessageId } from '@spyria/kernel'
import { useEffect, useRef, useState } from 'react'
import { matchOffsetsIn, searchNeedleOf } from '../domain/text-search.ts'

export const findRequestKey = 'findInChat'
export type FindRequest = Readonly<{ text: string; messageId: MessageId | null }>

const matchHighlightName = 'find-match'
const currentHighlightName = 'find-current'
const supportsHighlights = () => typeof CSS !== 'undefined' && 'highlights' in CSS
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const rangesIn = (root: HTMLElement, needle: string) => {
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    for (const offset of matchOffsetsIn(node.textContent ?? '', needle)) {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + needle.length)
      ranges.push(range)
    }
  return ranges
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
