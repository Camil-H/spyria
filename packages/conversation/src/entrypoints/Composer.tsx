import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { useStore } from '@spyria/db/react'
import type { ChatId, MessageId, WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { focusRing, tooltipClass } from '@spyria/ui'
import { ArrowUp } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { getDraft } from '../queries/get-draft.ts'
import { useConversationCommands } from './providers.tsx'

const isBlank = (text: string) => text.trim() === ''

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
    await commands.sendMessage({ workspaceId, chatId, text, threadRootId })
  }
  const sendOnShortcut = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    }
  }
  return (
    <Provider>
      {isBlocked && <div className="text-sm text-muted">{blockedNotice}</div>}
      {aboveBox}
      <div className="rounded-xl border border-line bg-raised">
        <div className="flex items-end gap-2 p-2">
          <textarea
            ref={textareaRef}
            aria-label={threadRootId ? 'Reply' : 'Message'}
            rows={1}
            className={`max-h-40 min-w-0 flex-1 resize-none rounded-md bg-transparent px-2 py-1.5 text-sm field-sizing-content ${focusRing}`}
            value={text}
            onChange={(event) => change(event.target.value)}
            onKeyDown={sendOnShortcut}
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
                Send (⌘↵)
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
