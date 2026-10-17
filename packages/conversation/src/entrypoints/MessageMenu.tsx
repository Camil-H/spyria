import type { MessageId, WorkspaceId } from '@hq/kernel'
import { ErrorMessage, focusRing, menuContentClass, useGuardedAction } from '@hq/ui'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import { useRef } from 'react'
import { useNavigate, useOutletContext } from 'react-router'
import { useConversationCommands } from './providers.tsx'

const menuItemClass =
  'flex cursor-pointer items-center rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40'

export const MessageMenu = ({
  messageId,
  canEdit,
  canReply,
  onReplyInThread,
  onEdit,
  onDelete,
}: {
  messageId: MessageId
  canEdit: boolean
  canReply: boolean
  onReplyInThread: (() => void) | undefined
  onEdit: () => void
  onDelete: () => void
}) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const navigate = useNavigate()
  const isOpeningThread = useRef(false)
  const { errorMessage, isPending, run } = useGuardedAction()
  const startRuntime = (event: Event) => {
    event.preventDefault()
    run(async () => {
      const newChatId = await commands.startRuntimeFromMessage({ workspaceId, messageId })
      navigate(`../${newChatId}`, { relative: 'path' })
    })
  }
  return (
    <Root>
      <Trigger
        aria-label="Message actions"
        className={`absolute top-1 right-2 rounded-md border border-line bg-raised p-1 text-muted opacity-0 hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 ${focusRing}`}
      >
        <Ellipsis aria-hidden className="size-4" />
      </Trigger>
      <Content
        align="end"
        className={menuContentClass}
        onCloseAutoFocus={(event) => {
          if (!isOpeningThread.current) return
          isOpeningThread.current = false
          event.preventDefault()
          onReplyInThread?.()
        }}
      >
        {onReplyInThread && (
          <Item
            className={menuItemClass}
            disabled={!canReply}
            onSelect={() => {
              isOpeningThread.current = true
            }}
          >
            Reply in thread
          </Item>
        )}
        <Item className={menuItemClass} disabled={isPending} onSelect={startRuntime}>
          {isPending ? 'Starting runtime…' : 'Start runtime from this message'}
        </Item>
        <Item className={menuItemClass} disabled={!canEdit} onSelect={onEdit}>
          Edit
        </Item>
        <Item className={menuItemClass} disabled={!canEdit} onSelect={onDelete}>
          Delete
        </Item>
        {errorMessage && (
          <div className="max-w-60 px-2 py-1.5">
            <ErrorMessage message={errorMessage} />
          </div>
        )}
      </Content>
    </Root>
  )
}
