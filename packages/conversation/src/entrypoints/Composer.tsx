import { useStore } from '@hq/db/react'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { focusRing, tooltipClass } from '@hq/ui'
import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { ArrowUp } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { saveDraft } from '../operations/save-draft.ts'
import { sendMessage } from '../operations/send-message.ts'
import { getDraft } from '../queries/get-draft.ts'
import { usePromptAccess } from './prompt-access.tsx'
import { useConversationDependencies } from './providers.tsx'

export const Composer = ({
  workspaceId,
  chatId,
  isRuntime,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  isRuntime: boolean
}) => {
  const { canPrompt, blockedNotice } = usePromptAccess()
  const dependencies = useConversationDependencies()
  const { memberId } = useSession()
  const store = useStore()
  const [text, setText] = useState(() => getDraft(workspaceId, chatId, memberId)(store.read()))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => textareaRef.current?.focus(), [])
  const isBlocked = isRuntime && !canPrompt
  const isUnsendable = text.trim() === '' || isBlocked
  const send = async () => {
    if (isUnsendable) return
    setText('')
    textareaRef.current?.focus()
    await sendMessage(dependencies, { chatId, authorId: memberId, text })
  }
  const change = (nextText: string) => {
    setText(nextText)
    saveDraft(dependencies, { workspaceId, chatId, memberId, text: nextText })
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
      <div className="flex items-end gap-2 rounded-xl border border-line bg-raised p-2">
        <textarea
          ref={textareaRef}
          aria-label="Message"
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
    </Provider>
  )
}
