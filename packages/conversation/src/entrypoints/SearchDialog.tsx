import { useQuery, useScoped } from '@spyria/db/react'
import { searchResultLimit, searchTextMaximumLength, searchTextMinimumLength } from '@spyria/db/zero-queries'
import type { WorkspaceId } from '@spyria/kernel'
import { chatTypeIconOf, Dialog, fieldClass, focusRing } from '@spyria/ui'
import { type KeyboardEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { searchNeedleOf } from '../domain/text-search.ts'
import { getSearchResults, type SearchHit, type SearchResult } from '../queries/search-messages.ts'
import { dateLabelOf } from './date-label.ts'
import { type FindRequest, findRequestKey } from './useFindInChat.ts'

const typingPauseMilliseconds = 250
const focusOnMount = (element: HTMLInputElement | null) => element?.focus()

const useSettledText = (text: string) => {
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const timer = setTimeout(setSettled, typingPauseMilliseconds, text)
    return () => clearTimeout(timer)
  }, [text])
  return settled
}

const ResultRow = ({
  result,
  isSelected,
  onOpen,
}: {
  result: SearchResult
  isSelected: boolean
  onOpen: () => void
}) => {
  const { Icon, label } = chatTypeIconOf(result.chatType)
  return (
    <li>
      <button
        type="button"
        tabIndex={-1}
        aria-current={isSelected}
        onClick={onOpen}
        ref={(element) => {
          if (isSelected) element?.scrollIntoView({ block: 'nearest' })
        }}
        className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${isSelected ? 'bg-selected' : 'hover:bg-hover'} ${focusRing}`}
      >
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Icon aria-label={label} role="img" size={12} className="shrink-0" />
          <span className="truncate font-medium text-ink">{result.chatName}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{result.authorName}</span>
          <time dateTime={result.createdAt} className="ml-auto shrink-0">
            {dateLabelOf(new Date(result.createdAt), new Date())}
          </time>
        </span>
        <span className="line-clamp-2 text-sm">
          {result.snippet.before}
          <mark className="rounded-sm bg-accent/30 text-ink">{result.snippet.match}</mark>
          {result.snippet.after}
        </span>
      </button>
    </li>
  )
}

const SearchDialog = ({ workspaceId, onClose }: { workspaceId: WorkspaceId; onClose: () => void }) => {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const needle = searchNeedleOf(useSettledText(text))
  const isSearchable = needle.length >= searchTextMinimumLength
  const status = useScoped(workspaceId, 'searchMessages', isSearchable ? { text: needle } : null)
  const results = useQuery(getSearchResults, workspaceId, (status?.rows ?? []) as readonly SearchHit[], needle)
  const isSearching = isSearchable && status?.isComplete !== true && results.length === 0
  const typedLength = searchNeedleOf(text).length
  const shownIndex = Math.min(selectedIndex, results.length - 1)
  const open = (result: SearchResult) => {
    const find: FindRequest = { text: needle, messageId: result.messageId }
    navigate(`/w/${workspaceId}/chats/${result.chatId}`, { state: { [findRequestKey]: find } })
    onClose()
  }
  const moveSelection = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step !== undefined && results.length > 0) {
      event.preventDefault()
      setSelectedIndex((shownIndex + step + results.length) % results.length)
    }
    const selected = results[shownIndex]
    if (event.key === 'Enter' && selected) {
      event.preventDefault()
      open(selected)
    }
  }
  return (
    <Dialog label="Search messages" closeLabel="Close" isWide onClose={onClose}>
      <input
        type="search"
        aria-label="Search messages"
        maxLength={searchTextMaximumLength}
        placeholder="Search the messages of the chats you can read"
        className={fieldClass}
        value={text}
        ref={focusOnMount}
        onChange={(event) => {
          setText(event.target.value)
          setSelectedIndex(0)
        }}
        onKeyDown={moveSelection}
      />
      {typedLength > 0 && typedLength < searchTextMinimumLength ? (
        <p className="text-sm text-muted">Type at least {searchTextMinimumLength} characters</p>
      ) : typedLength === 0 || !isSearchable ? null : isSearching ? (
        <p className="text-sm text-muted">Searching…</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-muted">No messages match “{text.trim()}”</p>
      ) : (
        <>
          <ul aria-label="Search results" className="-mx-2 flex min-h-0 flex-col overflow-y-auto">
            {results.map((result, index) => (
              <ResultRow
                key={result.hitId}
                result={result}
                isSelected={index === shownIndex}
                onOpen={() => open(result)}
              />
            ))}
          </ul>
          {(status?.rows.length ?? 0) >= searchResultLimit && (
            <p className="text-xs text-muted">Showing the {searchResultLimit} newest matches</p>
          )}
        </>
      )}
    </Dialog>
  )
}

export default SearchDialog
