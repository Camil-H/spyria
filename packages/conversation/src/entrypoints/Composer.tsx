import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { useQuery, useStore } from '@spyria/db/react'
import type { ChatId, MessageId, WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { ErrorMessage, focusRing, tooltipClass, useGuardedAction } from '@spyria/ui'
import { ArrowUp, Paperclip, X } from 'lucide-react'
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { type Attachment, fileSizeOf, maximumAttachmentsPerMessage, maximumMediaBytes } from '../domain/attachments.ts'
import { mentionCandidatesOf, mentionQueryAt, mentionTextOf } from '../domain/mentions.ts'
import { getDraft } from '../queries/get-draft.ts'
import { getMentionableNames } from '../queries/get-mentionable-names.ts'
import { continuedList, formattedText, formattingOfKey, linkedPaste, type TextEdit } from './composer-formatting.ts'
import { useConversationCommands } from './providers.tsx'

const isBlank = (text: string) => text.trim() === ''
const isApplePlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const sendKeyLabel = isApplePlatform ? '⌘↵' : 'Ctrl+Enter'
const acceptedFiles =
  'image/png,image/jpeg,image/gif,image/webp,audio/*,video/mp4,video/webm,video/quicktime,application/pdf'
const iconButtonClass = `rounded-full p-2 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`

type PendingAttachment = Readonly<{ key: string; name: string; attachment?: Attachment; failure?: string }>

const selectionOf = (textarea: HTMLTextAreaElement) => ({
  text: textarea.value,
  start: textarea.selectionStart,
  end: textarea.selectionEnd,
})

const insertKeepingUndo = (textarea: HTMLTextAreaElement, edit: TextEdit, onUnsupported: (text: string) => void) => {
  textarea.setSelectionRange(edit.start, edit.end)
  const isNothingToChange = edit.insert === '' && edit.start === edit.end
  const isInserted =
    isNothingToChange ||
    (edit.insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, edit.insert))
  if (!isInserted) {
    textarea.setRangeText(edit.insert, edit.start, edit.end)
    onUnsupported(textarea.value)
  }
  textarea.setSelectionRange(edit.selectStart, edit.selectEnd)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'Not uploaded')

const Shortcut = ({ label, children }: { label: string; children: ReactNode }) => (
  <Root>
    {children}
    <Portal>
      <Content sideOffset={6} className={tooltipClass}>
        {label}
      </Content>
    </Portal>
  </Root>
)

const MentionList = ({
  id,
  names,
  highlighted,
  onChoose,
}: {
  id: string
  names: readonly string[]
  highlighted: number
  onChoose: (name: string) => void
}) => (
  <div
    id={id}
    role="listbox"
    aria-label="Members to mention"
    className="absolute bottom-full left-0 z-10 mb-1 flex w-64 max-w-full flex-col rounded-md border border-line bg-raised py-1 shadow-md"
  >
    {names.map((name, index) => (
      <div
        key={name}
        id={`${id}-${index}`}
        role="option"
        tabIndex={-1}
        aria-selected={index === highlighted}
        onMouseDown={(event) => {
          event.preventDefault()
          onChoose(name)
        }}
        className="cursor-pointer truncate px-3 py-1 text-sm hover:bg-hover aria-selected:bg-selected"
      >
        {name}
      </div>
    ))}
  </div>
)

const PendingAttachments = ({
  pending,
  onRemove,
}: {
  pending: readonly PendingAttachment[]
  onRemove: (key: string) => void
}) => (
  <ul aria-label="Files to send" className="flex flex-wrap gap-1 px-2 pt-2">
    {pending.map(({ key, name, attachment, failure }) => (
      <li
        key={key}
        className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-app py-0.5 pr-0.5 pl-2 text-xs"
      >
        <span className="max-w-40 shrink-0 truncate">{name}</span>
        <span className="min-w-0 truncate text-muted" title={failure} role={failure ? 'alert' : undefined}>
          {failure ?? (attachment ? fileSizeOf(attachment.size) : 'Uploading…')}
        </span>
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={() => onRemove(key)}
          className={`rounded p-0.5 text-muted hover:bg-hover hover:text-ink ${focusRing}`}
        >
          <X aria-hidden size={12} />
        </button>
      </li>
    ))}
  </ul>
)

export const Composer = ({
  workspaceId,
  chatId,
  threadRootId,
  isBlocked,
  blockedNotice,
  aboveBox,
  bottomBar,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  threadRootId?: MessageId
  isBlocked: boolean
  blockedNotice: ReactNode
  aboveBox?: ReactNode
  bottomBar?: ReactNode
}) => {
  const commands = useConversationCommands()
  const { memberId } = useSession()
  const store = useStore()
  const [text, setText] = useState(() => (threadRootId ? '' : getDraft(workspaceId, chatId, memberId)(store.read())))
  const [pending, setPending] = useState<readonly PendingAttachment[]>([])
  const latestText = useRef(text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sending = useGuardedAction()
  const mentionListId = useId()
  const mentionNames = useQuery(getMentionableNames, workspaceId)
  const [caret, setCaret] = useState<number>()
  const [dismissedMentionStart, setDismissedMentionStart] = useState<number>()
  const [highlightedMention, setHighlightedMention] = useState(0)
  const mentionQuery = caret === undefined ? undefined : mentionQueryAt(text, caret)
  const mentionCandidates =
    mentionQuery && mentionQuery.start !== dismissedMentionStart
      ? mentionCandidatesOf(mentionNames, mentionQuery.query)
      : []
  const highlighted = Math.min(highlightedMention, mentionCandidates.length - 1)
  useEffect(() => {
    textareaRef.current?.focus()
    if (threadRootId) return
    const saveLatestText = () => commands.saveDraft({ workspaceId, chatId, text: latestText.current })
    document.addEventListener('visibilitychange', saveLatestText)
    return () => {
      document.removeEventListener('visibilitychange', saveLatestText)
      saveLatestText()
    }
  }, [commands, workspaceId, chatId, threadRootId])
  const readyAttachments = pending.flatMap(({ attachment }) => (attachment ? [attachment] : []))
  const isUploading = pending.some(({ attachment, failure }) => !attachment && !failure)
  const isUnsendable = (isBlank(text) && readyAttachments.length === 0) || isBlocked || isUploading
  const change = (nextText: string) => {
    if (!threadRootId && isBlank(nextText) !== isBlank(latestText.current))
      commands.saveDraft({ workspaceId, chatId, text: nextText })
    latestText.current = nextText
    setText(nextText)
  }
  const updatePending = (key: string, fields: Pick<PendingAttachment, 'attachment' | 'failure'>) =>
    setPending((current) => current.map((item) => (item.key === key ? { ...item, ...fields } : item)))
  const attach = (files: readonly File[]) => {
    const room = Math.max(0, maximumAttachmentsPerMessage - pending.length)
    const added = files.map((file, index) => ({
      file,
      key: crypto.randomUUID(),
      name: file.name,
      failure:
        index >= room
          ? `not added: up to ${maximumAttachmentsPerMessage} per message`
          : file.size > maximumMediaBytes
            ? 'over 20 MB'
            : undefined,
    }))
    setPending((current) => [...current, ...added.map(({ file, ...item }) => item)])
    for (const { file, key, failure } of added)
      if (!failure)
        commands.uploadAttachment({ workspaceId, chatId, file }).then(
          (attachment) => updatePending(key, { attachment }),
          (error: unknown) => updatePending(key, { failure: messageOf(error) }),
        )
  }
  const send = async () => {
    if (isUnsendable) return
    const sentPending = pending
    change('')
    setPending([])
    textareaRef.current?.focus()
    const attachments = readyAttachments.length > 0 ? readyAttachments : undefined
    if (await sending.run(() => commands.sendMessage({ workspaceId, chatId, text, threadRootId, attachments }))) return
    change(isBlank(latestText.current) ? text : `${text}\n${latestText.current}`)
    setPending((current) => [...sentPending, ...current])
  }
  const edit = (textarea: HTMLTextAreaElement, textEdit: TextEdit | undefined) => {
    if (!textEdit) return false
    insertKeepingUndo(textarea, textEdit, change)
    return true
  }
  const followCaret = (textarea: HTMLTextAreaElement) => {
    const nextCaret = textarea.selectionStart === textarea.selectionEnd ? textarea.selectionEnd : undefined
    if (nextCaret !== caret) setHighlightedMention(0)
    if (mentionQueryAt(textarea.value, nextCaret ?? 0)?.start !== dismissedMentionStart)
      setDismissedMentionStart(undefined)
    setCaret(nextCaret)
  }
  const mention = (name: string) => {
    const textarea = textareaRef.current
    if (!textarea || !mentionQuery) return
    const insert = mentionTextOf(name)
    const end = mentionQuery.start + insert.length
    edit(textarea, { start: mentionQuery.start, end: textarea.selectionEnd, insert, selectStart: end, selectEnd: end })
    setDismissedMentionStart(mentionQuery.start)
  }
  const handleMentionKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const count = mentionCandidates.length
    const chosen = mentionCandidates[highlighted]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      setHighlightedMention((highlighted + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
    else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      if (chosen) mention(chosen)
    } else if (event.key === 'Escape') setDismissedMentionStart(mentionQuery?.start)
    else return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget
    const isPrimary = isApplePlatform ? event.metaKey : event.ctrlKey
    const isOtherModifier = event.altKey || (isApplePlatform ? event.ctrlKey : event.metaKey)
    const isPlainKey = !isPrimary && !isOtherModifier && !event.nativeEvent.isComposing
    if (mentionCandidates.length > 0 && isPlainKey && handleMentionKey(event)) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !isPrimary && !isOtherModifier && !event.nativeEvent.isComposing) {
      if (edit(textarea, continuedList(selectionOf(textarea)))) event.preventDefault()
      return
    }
    const formatting = formattingOfKey({ key: event.key, isPrimary, isShift: event.shiftKey, isOtherModifier })
    if (formatting && edit(textarea, formattedText(selectionOf(textarea), formatting))) event.preventDefault()
  }
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const { clipboardData, currentTarget } = event
    if (clipboardData.files.length > 0 && !clipboardData.types.includes('text/plain')) {
      event.preventDefault()
      if (!isBlocked) attach([...clipboardData.files])
      return
    }
    if (edit(currentTarget, linkedPaste(selectionOf(currentTarget), clipboardData.getData('text/plain'))))
      event.preventDefault()
  }
  const dragOver = (event: DragEvent) => {
    if (!isBlocked && event.dataTransfer.types.includes('Files')) event.preventDefault()
  }
  const drop = (event: DragEvent) => {
    if (isBlocked || event.dataTransfer.files.length === 0) return
    event.preventDefault()
    attach([...event.dataTransfer.files])
  }
  return (
    <Provider>
      {isBlocked && <div className="text-sm text-muted">{blockedNotice}</div>}
      {aboveBox}
      <ErrorMessage message={sending.errorMessage && `Not sent: ${sending.errorMessage}`} />
      <div className="relative rounded-xl border border-line bg-raised has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-focus has-[textarea:focus-visible]:-outline-offset-1">
        {mentionCandidates.length > 0 && (
          <MentionList id={mentionListId} names={mentionCandidates} highlighted={highlighted} onChoose={mention} />
        )}
        {pending.length > 0 && (
          <PendingAttachments
            pending={pending}
            onRemove={(key) => setPending((current) => current.filter((item) => item.key !== key))}
          />
        )}
        <div className="flex items-end gap-1 p-2">
          <textarea
            ref={textareaRef}
            aria-label={threadRootId ? 'Reply' : 'Message'}
            rows={1}
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-5 outline-none field-sizing-content"
            value={text}
            aria-autocomplete="list"
            aria-controls={mentionCandidates.length > 0 ? mentionListId : undefined}
            aria-activedescendant={mentionCandidates.length > 0 ? `${mentionListId}-${highlighted}` : undefined}
            onChange={(event) => {
              change(event.target.value)
              followCaret(event.target)
            }}
            onSelect={(event) => followCaret(event.currentTarget)}
            onBlur={() => setCaret(undefined)}
            onKeyDown={handleKey}
            onPaste={paste}
            onDragOver={dragOver}
            onDrop={drop}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={acceptedFiles}
            hidden
            onChange={(event) => {
              attach([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
          <Shortcut label="Attach an image, a sound, a video or a PDF (up to 20 MB)">
            <Trigger
              type="button"
              aria-label="Attach files"
              disabled={isBlocked}
              onClick={() => fileInputRef.current?.click()}
              className={`${iconButtonClass} text-muted hover:bg-hover hover:text-ink disabled:hover:bg-transparent`}
            >
              <Paperclip aria-hidden size={18} />
            </Trigger>
          </Shortcut>
          <Shortcut label={`Send (${sendKeyLabel})`}>
            <Trigger
              type="button"
              aria-label="Send"
              disabled={isUnsendable}
              onClick={send}
              className={`${iconButtonClass} bg-accent text-accent-ink hover:bg-accent-hover disabled:hover:bg-accent`}
            >
              <ArrowUp aria-hidden size={18} />
            </Trigger>
          </Shortcut>
        </div>
        {bottomBar && (
          <div className="flex min-w-0 items-center gap-1 border-t border-line px-1.5 py-1">{bottomBar}</div>
        )}
      </div>
    </Provider>
  )
}
