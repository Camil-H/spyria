import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { useStore } from '@spyria/db/react'
import type { ChatId, MessageId, WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { ErrorMessage, focusRing, tooltipClass, useGuardedAction } from '@spyria/ui'
import { ArrowUp } from 'lucide-react'
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { getDraft } from '../queries/get-draft.ts'
import { continuedList, formattedText, formattingOfKey, linkedPaste, type TextEdit } from './composer-formatting.ts'
import { useConversationCommands } from './providers.tsx'

const isBlank = (text: string) => text.trim() === ''
const isApplePlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const sendKeyLabel = isApplePlatform ? '⌘↵' : 'Ctrl+Enter'

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
  const latestText = useRef(text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sending = useGuardedAction()
  useEffect(() => {
    textareaRef.current?.focus()
    if (threadRootId) return
    const saveLatestText = () => commands.saveDraft({ workspaceId, chatId, text: latestText.current })
    window.addEventListener('pagehide', saveLatestText)
    return () => {
      window.removeEventListener('pagehide', saveLatestText)
      saveLatestText()
    }
  }, [commands, workspaceId, chatId, threadRootId])
  const isUnsendable = isBlank(text) || isBlocked
  const change = (nextText: string) => {
    if (!threadRootId && isBlank(nextText) !== isBlank(latestText.current))
      commands.saveDraft({ workspaceId, chatId, text: nextText })
    latestText.current = nextText
    setText(nextText)
  }
  const send = async () => {
    if (isUnsendable) return
    change('')
    textareaRef.current?.focus()
    if (await sending.run(() => commands.sendMessage({ workspaceId, chatId, text, threadRootId }))) return
    change(isBlank(latestText.current) ? text : `${text}\n${latestText.current}`)
  }
  const edit = (textarea: HTMLTextAreaElement, textEdit: TextEdit | undefined) => {
    if (!textEdit) return false
    insertKeepingUndo(textarea, textEdit, change)
    return true
  }
  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget
    const isPrimary = isApplePlatform ? event.metaKey : event.ctrlKey
    const isOtherModifier = event.altKey || (isApplePlatform ? event.ctrlKey : event.metaKey)
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
    if (edit(currentTarget, linkedPaste(selectionOf(currentTarget), clipboardData.getData('text/plain'))))
      event.preventDefault()
  }
  return (
    <Provider>
      {isBlocked && <div className="text-sm text-muted">{blockedNotice}</div>}
      {aboveBox}
      <ErrorMessage message={sending.errorMessage && `Not sent: ${sending.errorMessage}`} />
      <div className="rounded-xl border border-line bg-raised has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-focus has-[textarea:focus-visible]:-outline-offset-1">
        <div className="flex items-end gap-2 p-2">
          <textarea
            ref={textareaRef}
            aria-label={threadRootId ? 'Reply' : 'Message'}
            rows={1}
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-5 outline-none field-sizing-content"
            value={text}
            onChange={(event) => change(event.target.value)}
            onKeyDown={handleKey}
            onPaste={paste}
          />
          <Root>
            <Trigger
              type="button"
              aria-label="Send"
              disabled={isUnsendable}
              onClick={send}
              className={`rounded-full bg-accent p-2 text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent ${focusRing}`}
            >
              <ArrowUp aria-hidden size={18} />
            </Trigger>
            <Portal>
              <Content sideOffset={6} className={tooltipClass}>
                Send ({sendKeyLabel})
              </Content>
            </Portal>
          </Root>
        </div>
        {bottomBar && (
          <div className="flex min-w-0 items-center gap-1 border-t border-line px-1.5 py-1">{bottomBar}</div>
        )}
      </div>
    </Provider>
  )
}
