import type { MessageId, WorkspaceId } from '@hq/kernel'
import { focusRing, menuContentClass } from '@hq/ui'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import { useNavigate, useOutletContext } from 'react-router'
import { useConversationCommands } from './providers.tsx'

const menuItemClass =
  'flex cursor-pointer items-center rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40'

export const MessageMenu = ({
  messageId,
  canEdit,
  onEdit,
  onDelete,
}: {
  messageId: MessageId
  canEdit: boolean
  onEdit: () => void
  onDelete: () => void
}) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const navigate = useNavigate()
  const startRuntime = async () => {
    const newChatId = await commands.startRuntimeFromMessage({ workspaceId, messageId })
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
        <Item className={menuItemClass} disabled={!canEdit} onSelect={onEdit}>
          Edit
        </Item>
        <Item className={menuItemClass} disabled={!canEdit} onSelect={onDelete}>
          Delete
        </Item>
      </Content>
    </Root>
  )
}
