import { focusRing } from '@spyria/ui'
import { ChevronRight } from 'lucide-react'
import { type Ref, useDeferredValue, useRef, useState } from 'react'
import type { Conversation, ConversationItem } from '../queries/get-conversation.ts'
import { MessageItem } from './MessageItem.tsx'

const scrollIntoView = (element: HTMLElement | null) => element?.scrollIntoView({ block: 'end' })

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
  const renderedItems = useDeferredValue(items)
  const shownItems = renderedItems === items ? items : items.slice(-(renderedItems.length + newItemsPaintedFirst))
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto pr-3 scrollbar-thin"
      onScroll={({ currentTarget: { scrollTop } }) => {
        if (scrollTop < previousScrollTop.current && scrollTop < earlierThresholdPixels) onLoadEarlier?.()
        previousScrollTop.current = scrollTop
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
            const ref = index === shownItems.length - 1 ? scrollIntoView : undefined
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
        <div ref={scrollIntoView} className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
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
  )
}
