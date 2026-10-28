import { focusRing } from '@spyria/ui'
import { ArrowDown, ChevronRight } from 'lucide-react'
import { type Ref, useDeferredValue, useRef, useState } from 'react'
import type { Conversation, ConversationItem } from '../queries/get-conversation.ts'
import { MessageItem } from './MessageItem.tsx'

const scrollIntoView = (element: HTMLElement | null) => element?.scrollIntoView({ block: 'end' })
const isSentByViewer = (item: ConversationItem | undefined) =>
  item?.type === 'message' && item.message.kind === 'member' && item.message.canEdit
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const FoldedSteps = ({
  fold,
  ref,
}: {
  fold: Extract<ConversationItem, { type: 'fold' }>
  ref?: Ref<HTMLLIElement>
}) => {
  const [isExpanded, setIsExpanded] = useState(false)
  return (
    <>
      <li ref={ref} className="rounded-md px-3 py-1 hover:bg-hover">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded(!isExpanded)}
          className={`flex items-center gap-1.5 rounded-md text-sm text-muted hover:text-ink ${focusRing} aria-expanded:[&>svg]:rotate-90`}
        >
          <ChevronRight aria-hidden className="size-4 transition-transform" />
          {fold.label}
        </button>
      </li>
      {isExpanded && fold.steps.map((step) => <MessageItem key={step.id} message={step} hasMenu={false} />)}
    </>
  )
}

const earlierThresholdPixels = 400
const bottomSlackPixels = 48
const newItemsPaintedFirst = 10

export const MessageList = ({
  conversation,
  items,
  isComplete,
  onLoadEarlier,
  onStop,
  onFork,
}: {
  conversation: Conversation
  items: readonly ConversationItem[]
  isComplete: boolean
  onLoadEarlier: (() => void) | undefined
  onStop: (() => void) | undefined
  onFork: (() => Promise<unknown>) | undefined
}) => {
  const previousScrollTop = useRef(0)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const isFollowingNewest = useRef(true)
  const [isAwayFromNewest, setIsAwayFromNewest] = useState(false)
  const renderedItems = useDeferredValue(items)
  const shownItems =
    renderedItems === items || renderedItems.length === 0
      ? items
      : items.slice(-(renderedItems.length + newItemsPaintedFirst))
  const followNewest = (element: HTMLElement | null) => {
    if (isFollowingNewest.current) scrollIntoView(element)
  }
  const goToNewest = () =>
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto pr-3 scrollbar-thin"
        onScroll={({ currentTarget: { scrollTop, scrollHeight, clientHeight } }) => {
          if (scrollTop < previousScrollTop.current && scrollTop < earlierThresholdPixels) onLoadEarlier?.()
          previousScrollTop.current = scrollTop
          isFollowingNewest.current = scrollHeight - scrollTop - clientHeight <= bottomSlackPixels
          setIsAwayFromNewest(!isFollowingNewest.current)
        }}
      >
        {onLoadEarlier && (
          <button
            type="button"
            onClick={onLoadEarlier}
            className={`mx-auto mb-2 block rounded-full px-3 py-1 text-xs text-muted hover:bg-hover hover:text-ink ${focusRing}`}
          >
            Show earlier messages
          </button>
        )}
        {shownItems.length === 0 ? (
          isComplete && <p className="px-3 py-2 text-sm text-muted">No messages yet</p>
        ) : (
          <ol aria-label="Messages" className="flex flex-col gap-1">
            {shownItems.map((item, index) => {
              const ref =
                index !== shownItems.length - 1 ? undefined : isSentByViewer(item) ? scrollIntoView : followNewest
              return item.type === 'fold' ? (
                <FoldedSteps key={`fold-${item.promptId}`} fold={item} ref={ref} />
              ) : (
                <MessageItem
                  key={item.message.id}
                  message={item.message}
                  hasMenu={conversation.type === 'channel'}
                  onFork={onFork}
                  ref={ref}
                />
              )
            })}
          </ol>
        )}
        {conversation.isAgentWorking && (
          <div ref={followNewest} className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
            <span role="status" aria-label="Agent is working" className="flex items-center gap-2">
              <span aria-hidden className="size-2 animate-pulse rounded-full bg-accent" />
              Agent is working…
            </span>
            {conversation.hasActiveTurn && onStop && (
              <button
                type="button"
                onClick={onStop}
                className={`rounded-full border border-line px-2 py-0.5 text-xs text-ink hover:bg-hover ${focusRing}`}
              >
                Stop
              </button>
            )}
          </div>
        )}
      </div>
      {isAwayFromNewest && (
        <button
          type="button"
          onClick={goToNewest}
          className={`absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1 text-xs text-ink shadow-md hover:bg-hover ${focusRing}`}
        >
          <ArrowDown aria-hidden size={14} />
          Go to last message
        </button>
      )}
    </div>
  )
}
