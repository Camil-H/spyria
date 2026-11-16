import { useQuery, useScoped } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import {
  calloutClass,
  fieldClass,
  focusRing,
  ghostButtonClass,
  iconButtonClass,
  Spinner,
  smallGhostButtonClass,
} from '@spyria/ui'
import { ArrowLeft, ArrowRight, ExternalLink, FileText, RotateCw } from 'lucide-react'
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  type BrowserPage,
  browsedPageOf,
  isHtmlFile,
  isWebAddress,
  maximumUploadBytes,
  mouseButtonOf,
  pageKeyOf,
  pagePointOf,
  stateTextOf,
} from '../domain/browser.ts'
import { getOpenedPages } from '../queries/get-browser.ts'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { type LiveBrowser, useLiveBrowser } from './useLiveBrowser.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'

const frameClass = 'min-h-80 w-full flex-1 rounded-md border border-line bg-white'
const reportFramePath = '/report-frame.html'
const warningSeenKey = 'spyria.browser-warning-seen'
const resizeDelayMilliseconds = 200
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

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

const OpenedFiles = ({ pages, onOpen }: { pages: readonly BrowserPage[]; onOpen: (page: BrowserPage) => void }) => (
  <ul aria-label="Files the agent opened" className="flex flex-col gap-1 text-sm">
    {pages.map((page) => (
      <li key={page.url}>
        <button
          type="button"
          onClick={() => onOpen(page)}
          className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-hover ${focusRing}`}
        >
          <span className="max-w-full truncate font-medium">{page.title}</span>
          {page.title !== page.url && <span className="max-w-full truncate text-xs text-muted">{page.url}</span>}
        </button>
      </li>
    ))}
  </ul>
)

const SharedChatWarning = () => {
  const [isSeen, setIsSeen] = useState(() => localStorage.getItem(warningSeenKey) === 'yes')
  if (isSeen) return null
  return (
    <div className={`${calloutClass} flex flex-col items-start gap-2`}>
      <p>
        Only you see this browser, and it keeps your sign-ins for this chat. When you prompt the agent, it can read and
        act in it, and what it reads can end up in the chat, where everyone in it can see it.
      </p>
      <button
        type="button"
        className={smallGhostButtonClass}
        onClick={() => {
          localStorage.setItem(warningSeenKey, 'yes')
          setIsSeen(true)
        }}
      >
        Got it
      </button>
    </div>
  )
}

const filesOf = async (list: FileList) => {
  const files = [...list]
  if (files.reduce((total, file) => total + file.size, 0) > maximumUploadBytes) return undefined
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      data: btoa(Array.from(new Uint8Array(await file.arrayBuffer()), (byte) => String.fromCharCode(byte)).join('')),
    })),
  )
}

const FileRequest = ({ live }: { live: LiveBrowser }) => {
  const [isTooLarge, setIsTooLarge] = useState(false)
  if (!live.fileChooser) return null
  return (
    <div className={`${calloutClass} flex flex-col items-start gap-2`}>
      <label className="flex flex-col gap-1">
        The page asks for {live.fileChooser.multiple ? 'files' : 'a file'}
        <input
          type="file"
          multiple={live.fileChooser.multiple}
          onChange={async (event) => {
            const files = event.target.files && (await filesOf(event.target.files))
            if (!files) return setIsTooLarge(true)
            live.send({ type: 'files', files })
            live.closeFileChooser()
          }}
        />
      </label>
      {isTooLarge && <p className="text-xs">Files over 8 MB in all are not sent</p>}
      <button type="button" className={smallGhostButtonClass} onClick={live.closeFileChooser}>
        Cancel
      </button>
    </div>
  )
}

const BrowserStatus = ({ live, onReconnect }: { live: LiveBrowser; onReconnect: () => void }) => {
  const text = stateTextOf(live.state)
  if (!text) return null
  const isBusy = live.state.state === 'connecting' || live.state.state === 'starting'
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-app/90 p-4 text-center text-sm">
      {isBusy && <Spinner />}
      <p>{text}</p>
      {live.state.state === 'stopped' && (
        <button type="button" className={ghostButtonClass} onClick={live.start}>
          Start again
        </button>
      )}
      {live.state.state === 'disconnected' && (
        <button type="button" className={ghostButtonClass} onClick={onReconnect}>
          Reconnect
        </button>
      )}
    </div>
  )
}

const isPasteShortcut = (event: KeyboardEvent) => event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey)

const BrowserView = ({
  live,
  canBrowse,
  onReconnect,
}: {
  live: LiveBrowser
  canBrowse: boolean
  onReconnect: () => void
}) => {
  const area = useRef<HTMLDivElement>(null)
  const isMovePending = useRef(false)
  const shownSize = useRef<{ width: number; height: number }>(undefined)
  const latest = useRef({ frame: live.frame, canBrowse })
  const { frame, send } = live
  const isRunning = live.state.state === 'running'
  useEffect(() => {
    latest.current = { frame, canBrowse }
  })
  useEffect(() => {
    if (isRunning && shownSize.current) send({ type: 'resize', ...shownSize.current })
  }, [isRunning, send])
  useEffect(() => {
    const element = area.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0)
      const height = Math.round(entry?.contentRect.height ?? 0)
      if (shownSize.current?.width === width && shownSize.current.height === height) return
      shownSize.current = { width, height }
      clearTimeout(timer)
      timer = setTimeout(() => send({ type: 'resize', width, height }), resizeDelayMilliseconds)
    })
    observer.observe(element)
    const scroll = (event: WheelEvent) => {
      const shown = latest.current
      if (!shown.canBrowse || !shown.frame) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const point = pagePointOf({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, shown.frame)
      send({
        type: 'input',
        event: { kind: 'mouse', action: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY },
      })
    }
    element.addEventListener('wheel', scroll, { passive: false })
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      element.removeEventListener('wheel', scroll)
    }
  }, [send])
  const mouse = (action: 'down' | 'up' | 'move') => (event: MouseEvent<HTMLDivElement>) => {
    if (!canBrowse || !frame) return
    if (action === 'move' && isMovePending.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const point = pagePointOf({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, frame)
    const modifiers = { alt: event.altKey, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }
    const input = {
      kind: 'mouse',
      action,
      ...point,
      button: mouseButtonOf(event.button),
      clickCount: event.detail,
      ...modifiers,
    }
    if (action !== 'move') return send({ type: 'input', event: input })
    isMovePending.current = true
    requestAnimationFrame(() => {
      isMovePending.current = false
      send({ type: 'input', event: input })
    })
  }
  const key = (action: 'down' | 'up') => (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canBrowse || isPasteShortcut(event)) return
    event.preventDefault()
    send({ type: 'input', event: { kind: 'key', action, key: pageKeyOf(event.key, isMac) } })
  }
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!canBrowse) return
    event.preventDefault()
    send({ type: 'input', event: { kind: 'text', text: event.clipboardData.getData('text') } })
  }
  return (
    <div
      ref={area}
      role="application"
      aria-label="Your browser"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: an ARIA application takes focus to pass the member's keys to the live page
      tabIndex={0}
      onMouseDown={(event) => {
        event.currentTarget.focus()
        mouse('down')(event)
      }}
      onMouseUp={mouse('up')}
      onMouseMove={mouse('move')}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={key('down')}
      onKeyUp={key('up')}
      onPaste={paste}
      className={`relative min-h-80 flex-1 overflow-hidden rounded-md border border-line bg-white ${focusRing}`}
    >
      {frame && (
        <img
          src={`data:image/jpeg;base64,${frame.data}`}
          alt={live.page?.title || 'The page in your browser'}
          draggable={false}
          className="pointer-events-none h-full w-full select-none"
        />
      )}
      <BrowserStatus live={live} onReconnect={onReconnect} />
    </div>
  )
}

const AddressBar = ({ live, canBrowse }: { live: LiveBrowser; canBrowse: boolean }) => {
  const go = (direction: 'back' | 'forward' | 'reload') => live.send({ type: 'go', direction })
  const browse = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const page = browsedPageOf(String(new FormData(event.currentTarget).get('address') ?? ''))
    if (page) live.send({ type: 'go_to', url: page.url })
  }
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Back"
        title="Back"
        disabled={!canBrowse}
        onClick={() => go('back')}
        className={iconButtonClass}
      >
        <ArrowLeft aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        title="Forward"
        disabled={!canBrowse}
        onClick={() => go('forward')}
        className={iconButtonClass}
      >
        <ArrowRight aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Reload"
        title="Reload"
        disabled={!canBrowse}
        onClick={() => go('reload')}
        className={iconButtonClass}
      >
        <RotateCw aria-hidden className="size-4" />
      </button>
      <search className="min-w-0 flex-1">
        <form aria-label="Browse" onSubmit={browse}>
          <input
            key={live.page?.url}
            type="search"
            name="address"
            aria-label="Search or type an address"
            placeholder="Search or type an address"
            defaultValue={live.page?.url}
            readOnly={!canBrowse}
            className={`${fieldClass} w-full`}
          />
        </form>
      </search>
    </div>
  )
}

const LiveBrowserTab = ({
  workspaceId,
  chatId,
  actionsSlot,
  onReconnect,
}: Omit<TabProps, 'Markdown'> & { onReconnect: () => void }) => {
  const live = useLiveBrowser(workspaceId, chatId)
  const canBrowse = live.state.state === 'running' && live.state.canBrowse
  return (
    <>
      <AddressBar live={live} canBrowse={canBrowse} />
      <SharedChatWarning />
      <FileRequest live={live} />
      <BrowserView live={live} canBrowse={canBrowse} onReconnect={onReconnect} />
      {live.notice && <p className="text-xs text-muted">{live.notice}</p>}
      {actionsSlot &&
        live.page &&
        isWebAddress(live.page.url) &&
        createPortal(
          <a
            href={live.page.url}
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
    </>
  )
}

export const BrowserTab = ({ workspaceId, chatId, actionsSlot }: TabProps) => {
  const status = useScoped(workspaceId, 'chatBrowserPages', { chatId })
  const files = useQuery(getOpenedPages, workspaceId, chatId)
  const isLoaded = status?.isComplete === true && files.length === status.rows.length
  const latestOpenedAt = files[0]?.openedAt ?? ''
  const [seenOpenedAt, setSeenOpenedAt] = useState<string>()
  const [shownFile, setShownFile] = useState<BrowserPage | null>(null)
  const [isListing, setIsListing] = useState(false)
  const [connectionCount, setConnectionCount] = useState(0)
  if (isLoaded && seenOpenedAt === undefined) setSeenOpenedAt(latestOpenedAt)
  if (seenOpenedAt !== undefined && latestOpenedAt > seenOpenedAt) {
    setSeenOpenedAt(latestOpenedAt)
    setShownFile(files[0] ?? null)
  }
  const openFile = (file: BrowserPage) => {
    setShownFile(file)
    setIsListing(false)
  }
  return (
    <div className="flex h-full flex-col gap-3">
      {files.length > 0 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={isListing || shownFile !== null}
            onClick={() => {
              setIsListing(!isListing && shownFile === null)
              setShownFile(null)
            }}
            className={`flex items-center gap-1.5 ${smallGhostButtonClass}`}
          >
            <FileText aria-hidden className="size-4" />
            {isListing || shownFile ? 'Back to your browser' : 'Files the agent opened'}
          </button>
          {shownFile && (
            <p className="min-w-0 truncate text-sm font-medium" title={shownFile.url}>
              {shownFile.title}
            </p>
          )}
        </div>
      )}
      {shownFile && <WorkspaceFile workspaceId={workspaceId} chatId={chatId} page={shownFile} />}
      {isListing && !shownFile && <OpenedFiles pages={files} onOpen={openFile} />}
      <div className={`flex min-h-0 flex-1 flex-col gap-3 ${shownFile || isListing ? 'hidden' : ''}`}>
        <LiveBrowserTab
          key={connectionCount}
          workspaceId={workspaceId}
          chatId={chatId}
          actionsSlot={actionsSlot}
          onReconnect={() => setConnectionCount((count) => count + 1)}
        />
      </div>
    </div>
  )
}
