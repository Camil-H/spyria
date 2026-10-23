import { useQuery, useScoped } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { fieldClass, focusRing, iconButtonClass } from '@spyria/ui'
import { ArrowLeft, ExternalLink, Globe } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { type BrowserPage, browsedPageOf, isHtmlFile, isWebAddress } from '../domain/browser.ts'
import { getOpenedPages } from '../queries/get-browser.ts'
import { EmptyState } from './EmptyState.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'

type Choice = Readonly<{ page: BrowserPage | null; seenOpenedAt: string }>

const frameClass = 'min-h-80 w-full flex-1 rounded-md border border-line bg-white'
const webPageSandbox = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'

const WorkspaceFile = ({
  workspaceId,
  chatId,
  page,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  page: BrowserPage
}) => {
  const { reading } = useWorkspaceReading(workspaceId, chatId, 'file', page.url)
  if (!reading) return null
  if (typeof reading.content !== 'string' || reading.isBinary === true)
    return <p className={emptyClass}>This file cannot be shown now</p>
  return isHtmlFile(page.url) ? (
    <iframe title={page.title} sandbox="allow-scripts" srcDoc={reading.content} className={frameClass} />
  ) : (
    <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-app p-2 font-mono text-xs whitespace-pre-wrap">
      {reading.content}
    </pre>
  )
}

const OpenedPages = ({ pages, onOpen }: { pages: readonly BrowserPage[]; onOpen: (page: BrowserPage) => void }) => (
  <ul aria-label="Pages the agent opened" className="flex flex-col gap-1 text-sm">
    {pages.map((page) => (
      <li key={page.url}>
        <button
          type="button"
          onClick={() => onOpen(page)}
          className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-hover ${focusRing}`}
        >
          <span className="font-medium">{page.title}</span>
          <span className="max-w-full truncate text-xs text-muted">{page.url}</span>
        </button>
      </li>
    ))}
  </ul>
)

export const BrowserTab = ({ workspaceId, chatId, actionsSlot }: TabProps) => {
  const isComplete = useScoped(workspaceId, 'chatBrowserPages', { chatId })?.isComplete === true
  const pages = useQuery(getOpenedPages, workspaceId, chatId)
  const latestOpenedAt = pages[0]?.openedAt ?? ''
  const [choice, setChoice] = useState<Choice>()
  if (isComplete && choice === undefined) setChoice({ page: null, seenOpenedAt: latestOpenedAt })
  const isNewlyOpened = choice !== undefined && latestOpenedAt > choice.seenOpenedAt
  const shown = isNewlyOpened ? (pages[0] ?? null) : (choice?.page ?? null)
  const choose = (page: BrowserPage | null) => setChoice({ page, seenOpenedAt: latestOpenedAt })
  const browse = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const page = browsedPageOf(String(new FormData(event.currentTarget).get('address') ?? ''))
    if (page) choose(page)
  }
  return (
    <div className="flex h-full flex-col gap-3">
      <search>
        <form aria-label="Browse" onSubmit={browse}>
          <input
            key={shown?.url}
            type="search"
            name="address"
            aria-label="Search or type an address"
            placeholder="Search or type an address"
            defaultValue={shown?.url}
            className={`${fieldClass} w-full`}
          />
        </form>
      </search>
      {shown ? (
        <>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="All pages"
              title="All pages"
              onClick={() => choose(null)}
              className={iconButtonClass}
            >
              <ArrowLeft aria-hidden className="size-4" />
            </button>
            <p className="min-w-0 truncate text-sm font-medium">{shown.title}</p>
          </div>
          {isWebAddress(shown.url) ? (
            <iframe
              key={shown.url}
              title={shown.title}
              src={shown.url}
              sandbox={webPageSandbox}
              referrerPolicy="no-referrer"
              className={frameClass}
            />
          ) : (
            <WorkspaceFile workspaceId={workspaceId} chatId={chatId} page={shown} />
          )}
        </>
      ) : pages.length > 0 ? (
        <OpenedPages pages={pages} onOpen={choose} />
      ) : (
        isComplete && (
          <EmptyState
            Icon={Globe}
            title="No page open"
            hint="Search or type an address above. Pages the agent opens for you, like a report it built, show here too."
          />
        )
      )}
      {actionsSlot &&
        shown &&
        isWebAddress(shown.url) &&
        createPortal(
          <a
            href={shown.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in a new tab"
            title="Open in a new tab"
            className={iconButtonClass}
          >
            <ExternalLink aria-hidden className="size-4" />
          </a>,
          actionsSlot,
        )}
    </div>
  )
}
