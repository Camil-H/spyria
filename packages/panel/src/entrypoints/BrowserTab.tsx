import { useQuery, useScoped } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { fieldClass, focusRing, ghostButtonClass, iconButtonClass } from '@spyria/ui'
import { ArrowLeft, ExternalLink, Globe } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { type BrowserPage, browsedPageOf, isHtmlFile, isWebAddress } from '../domain/browser.ts'
import { getOpenedPages } from '../queries/get-browser.ts'
import { EmptyState } from './EmptyState.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'

type Choice = Readonly<{ page: BrowserPage | null; isTyped: boolean; seenOpenedAt: string }>

const frameClass = 'min-h-80 w-full flex-1 rounded-md border border-line bg-white'
const reportFramePath = '/report-frame.html'
const webPageSandbox = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'

const ReportFrame = ({ title, content }: { title: string; content: string }) => (
  <iframe
    title={title}
    src={reportFramePath}
    sandbox="allow-scripts"
    onLoad={(event) => event.currentTarget.contentWindow?.postMessage(content, '*')}
    className={frameClass}
  />
)

const WorkspaceFile = ({
  workspaceId,
  chatId,
  page,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  page: BrowserPage
}) => {
  const { reading, readingVersion } = useWorkspaceReading(workspaceId, chatId, 'file', page.url)
  if (!reading) return null
  if (typeof reading.content !== 'string' || reading.isBinary === true)
    return <p className={emptyClass}>This file cannot be shown now</p>
  return isHtmlFile(page.url) ? (
    <ReportFrame key={`${page.url}|${readingVersion}`} title={page.url} content={reading.content} />
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
          <span className="max-w-full truncate font-medium">{page.url}</span>
          {page.title !== page.url && <span className="max-w-full truncate text-xs text-muted">{page.title}</span>}
        </button>
      </li>
    ))}
  </ul>
)

const ShownPage = ({
  workspaceId,
  chatId,
  page,
  isTyped,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  page: BrowserPage
  isTyped: boolean
}) => {
  const [isLoaded, setIsLoaded] = useState(false)
  if (!isTyped && !isLoaded)
    return (
      <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-line p-3 text-sm">
        <p className="text-muted">The agent opened this page. Check its address before you load it.</p>
        <p className="font-mono break-all">{page.url}</p>
        <button type="button" onClick={() => setIsLoaded(true)} className={ghostButtonClass}>
          Load page
        </button>
      </div>
    )
  return isWebAddress(page.url) ? (
    <iframe
      title={page.url}
      src={page.url}
      sandbox={webPageSandbox}
      referrerPolicy="no-referrer"
      className={frameClass}
    />
  ) : (
    <WorkspaceFile workspaceId={workspaceId} chatId={chatId} page={page} />
  )
}

export const BrowserTab = ({ workspaceId, chatId, actionsSlot }: TabProps) => {
  const status = useScoped(workspaceId, 'chatBrowserPages', { chatId })
  const isComplete = status?.isComplete === true
  const pages = useQuery(getOpenedPages, workspaceId, chatId)
  const isLoaded = isComplete && pages.length === status?.rows.length
  const latestOpenedAt = pages[0]?.openedAt ?? ''
  const [choice, setChoice] = useState<Choice>()
  if (isLoaded && choice === undefined) setChoice({ page: null, isTyped: false, seenOpenedAt: latestOpenedAt })
  const isNewlyOpened = choice !== undefined && latestOpenedAt > choice.seenOpenedAt
  const shown = isNewlyOpened ? (pages[0] ?? null) : (choice?.page ?? null)
  const isTyped = !isNewlyOpened && choice?.isTyped === true
  const choose = (page: BrowserPage | null, isTyped = false) =>
    setChoice({ page, isTyped, seenOpenedAt: latestOpenedAt })
  const browse = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const page = browsedPageOf(String(new FormData(event.currentTarget).get('address') ?? ''))
    if (page) choose(page, true)
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
            <p className="min-w-0 truncate text-sm font-medium" title={shown.url}>
              {shown.url}
            </p>
          </div>
          <ShownPage
            key={`${isTyped}:${shown.url}`}
            workspaceId={workspaceId}
            chatId={chatId}
            page={shown}
            isTyped={isTyped}
          />
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
