import type { MessageId } from '@hq/kernel'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { startRuntimeFromMessage } from '../operations/start-runtime-from-message.ts'
import { useConversationDependencies } from './providers.tsx'
import { focusRing, menuContentClass, menuItemClass } from './ui.ts'

export const MessageMenu = ({
  messageId,
  isOwn,
  onEdit,
  onDelete,
}: {
  messageId: MessageId
  isOwn: boolean
  onEdit: () => void
  onDelete: () => void
}) => {
  const dependencies = useConversationDependencies()
  const { memberId } = useSession()
  const navigate = useNavigate()
  const startRuntime = async () => {
    const newChatId = await startRuntimeFromMessage(dependencies, { messageId, memberId })
    navigate(`../${newChatId}`, { relative: 'path' })
  }
  return (
    <Root>
      <Trigger
        aria-label="Message actions"
        className={`absolute top-1 right-2 rounded-md border border-line bg-raised p-1 text-muted opacity-0 hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 ${focusRing}`}
      >
        <Ellipsis aria-hidden className="size-4" />
      </Trigger>
      <Content align="end" className={menuContentClass}>
        <Item className={menuItemClass} onSelect={startRuntime}>
          Start runtime from this message
        </Item>
        <Item className={menuItemClass} disabled={!isOwn} onSelect={onEdit}>
          Edit
        </Item>
        <Item className={menuItemClass} disabled={!isOwn} onSelect={onDelete}>
          Delete
        </Item>
      </Content>
    </Root>
  )
}
