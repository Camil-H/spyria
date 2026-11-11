import type { WorkspaceId } from '@spyria/kernel'
import { focusRing, IconButton, iconButtonClass } from '@spyria/ui'
import { Download, FileText, Image as ImageIcon, Play, X } from 'lucide-react'
import { type ReactNode, use, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOutletContext } from 'react-router'
import {
  type Attachment,
  chatAttachmentPathOf,
  chatMediaPathOf,
  fileSizeOf,
  type MediaKind,
  mediaKindOf,
  runtimeMediaKindOf,
} from '../domain/attachments.ts'
import { ChatMediaContext, useConversationCommands } from './providers.tsx'

const nearViewportMargin = '300px'
const mediaClassName = 'max-h-80 max-w-full rounded-md border border-line'
const mediaButtonClassName = `flex max-w-full items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-left text-sm hover:bg-hover ${focusRing}`

const useMediaUrl = (path: string, isWanted: boolean) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const [loaded, setLoaded] = useState<{ url?: string; failure?: string }>({})
  useEffect(() => {
    if (!isWanted) return
    let url: string | undefined
    let isCurrent = true
    commands.readMedia({ workspaceId, path }).then(
      (blob) => {
        url = URL.createObjectURL(blob)
        if (isCurrent) setLoaded({ url })
        else URL.revokeObjectURL(url)
      },
      (error: unknown) => isCurrent && setLoaded({ failure: error instanceof Error ? error.message : 'Not available' }),
    )
    return () => {
      isCurrent = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [commands, workspaceId, path, isWanted])
  return loaded
}

const useIsNearViewport = () => {
  const ref = useRef<HTMLSpanElement>(null)
  const [isNear, setIsNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || isNear) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setIsNear(true)
      },
      { rootMargin: nearViewportMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [isNear])
  return { ref, isNear }
}

const Failure = ({ name, failure }: { name: string; failure: string }) => (
  <span className="block text-xs text-muted">
    {name}: {failure}
  </span>
)

const showModal = (dialog: HTMLDialogElement | null) => {
  if (dialog && !dialog.open) dialog.showModal()
}

const ImageOverlay = ({ url, name, onClose }: { url: string; name: string; onClose: () => void }) => (
  <dialog
    ref={showModal}
    aria-label={name}
    onClose={onClose}
    onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }}
    onClick={(event) => event.target === event.currentTarget && onClose()}
    className="fixed inset-0 z-40 m-0 flex h-full max-h-none w-full max-w-none items-center justify-center bg-transparent p-12 backdrop:bg-black/80"
  >
    <div className="absolute top-3 right-3 flex items-center gap-1 rounded-md bg-raised shadow-lg">
      <a href={url} download={name} aria-label={`Save ${name}`} title={`Save ${name}`} className={iconButtonClass}>
        <Download aria-hidden size={18} />
      </a>
      <IconButton label="Close" icon={X} onClick={onClose} />
    </div>
    <img src={url} alt={name} className="max-h-full max-w-full rounded-md object-contain" />
  </dialog>
)

const LoadedImage = ({ url, name }: { url: string; name: string }) => {
  const [isEnlarged, setIsEnlarged] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={`Enlarge ${name}`}
        onClick={() => setIsEnlarged(true)}
        className={`inline-block cursor-zoom-in rounded-md ${focusRing}`}
      >
        <img src={url} alt={name} className={mediaClassName} />
      </button>
      {isEnlarged &&
        createPortal(<ImageOverlay url={url} name={name} onClose={() => setIsEnlarged(false)} />, document.body)}
    </>
  )
}

const ImageMedia = ({ path, name }: { path: string; name: string }) => {
  const { ref, isNear } = useIsNearViewport()
  const { url, failure } = useMediaUrl(path, isNear)
  if (failure) return <Failure name={name} failure={failure} />
  return (
    <span ref={ref} className="block">
      {url ? (
        <LoadedImage url={url} name={name} />
      ) : (
        <span role="img" aria-label={`Loading ${name}`} className="block h-40 w-60 animate-pulse rounded-md bg-hover" />
      )}
    </span>
  )
}

const kindLabel: Record<MediaKind, string> = { image: 'image', audio: 'sound', video: 'video', file: 'file' }

const OnDemandMedia = ({
  path,
  name,
  kind,
  detail,
}: {
  path: string
  name: string
  kind: MediaKind
  detail: string
}) => {
  const [isWanted, setIsWanted] = useState(false)
  const { url, failure } = useMediaUrl(path, isWanted)
  if (failure) return <Failure name={name} failure={failure} />
  if (url && kind === 'image') return <LoadedImage url={url} name={name} />
  if (url && kind === 'video')
    // biome-ignore lint/a11y/useMediaCaption: uploads and runtime files come without a caption track
    return <video src={url} controls autoPlay className={mediaClassName} />
  if (url && kind === 'audio')
    // biome-ignore lint/a11y/useMediaCaption: uploads and runtime files come without a caption track
    return <audio src={url} controls autoPlay className="max-w-full" />
  if (url)
    return (
      <a href={url} download={name} className="text-sm text-link underline">
        Save {name}
      </a>
    )
  return (
    <button type="button" onClick={() => setIsWanted(true)} aria-busy={isWanted} className={mediaButtonClassName}>
      {kind === 'file' ? (
        <FileText aria-hidden size={16} />
      ) : kind === 'image' ? (
        <ImageIcon aria-hidden size={16} />
      ) : (
        <Play aria-hidden size={16} />
      )}
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-xs text-muted">
        {isWanted ? 'Loading…' : detail ? `${kindLabel[kind]} · ${detail}` : kindLabel[kind]}
      </span>
    </button>
  )
}

const MediaOf = ({
  path,
  name,
  kind,
  detail,
  isOnDemand = false,
}: {
  path: string
  name: string
  kind: MediaKind
  detail: string
  isOnDemand?: boolean
}) =>
  kind === 'image' && !isOnDemand ? (
    <ImageMedia path={path} name={name} />
  ) : (
    <OnDemandMedia path={path} name={name} kind={kind} detail={detail} />
  )

export const AttachmentList = ({ attachments }: { attachments: readonly Attachment[] }) => {
  const chat = use(ChatMediaContext)
  if (!chat || attachments.length === 0) return null
  return (
    <ul aria-label="Attachments" className="mt-1 flex flex-wrap items-start gap-2">
      {attachments.map(({ id, name, mediaType, size }) => (
        <li key={id} className="max-w-full">
          <MediaOf
            path={chatAttachmentPathOf(chat.chatId, id)}
            name={name}
            kind={mediaKindOf(mediaType)}
            detail={fileSizeOf(size)}
          />
        </li>
      ))}
    </ul>
  )
}

export const RuntimeMedia = ({
  path,
  alt,
  isOnDemand,
  fallback,
}: {
  path: string
  alt: string
  isOnDemand: boolean
  fallback: ReactNode
}) => {
  const chat = use(ChatMediaContext)
  if (!chat?.isRuntime) return fallback
  const name = alt || path.split('/').at(-1) || path
  return (
    <MediaOf
      path={`${chatMediaPathOf(chat.chatId)}?${new URLSearchParams({ path })}`}
      name={name}
      kind={runtimeMediaKindOf(path)}
      detail=""
      isOnDemand={isOnDemand}
    />
  )
}
