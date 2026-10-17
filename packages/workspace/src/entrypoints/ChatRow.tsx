import type { ChatId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, menuContentClass, tooltipClass } from '@hq/ui'
import { Content, Item, Root, Sub, SubContent, SubTrigger, Trigger } from '@radix-ui/react-dropdown-menu'
import {
  Content as TooltipContent,
  Portal as TooltipPortal,
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
} from '@radix-ui/react-tooltip'
import { Bot, Ellipsis, Hash } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { NavLink } from 'react-router'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { NameDialog } from './NameDialog.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { menuItemClass, menuTriggerClass, navLinkClass } from './ui.ts'

type SidebarChat = Sidebar['looseChats'][number]
export type ChatAdornment = (chatId: ChatId) => ReactNode

export const ChatRow = ({
  workspaceId,
  chat,
  projects,
  chatAdornment,
}: {
  workspaceId: WorkspaceId
  chat: SidebarChat
  projects: Sidebar['projects']
  chatAdornment?: ChatAdornment
}) => {
  const commands = useWorkspaceCommands()
  const [openDialog, setOpenDialog] = useState<'rename' | 'archive' | null>(null)
  const closeDialog = () => setOpenDialog(null)
  const ChatTypeIcon = chat.type === 'channel' ? Hash : Bot
  const chatTypeLabel = chat.type === 'channel' ? 'Channel' : 'Runtime chat'
  return (
    <li className="flex items-center">
      <NavLink
        to={`/w/${workspaceId}/chats/${chat.id}`}
        className={navLinkClass('flex min-w-0 flex-1 items-center gap-2 py-1')}
      >
        <TooltipRoot disableHoverableContent>
          <TooltipTrigger asChild>
            <ChatTypeIcon aria-label={chatTypeLabel} role="img" size={14} className="shrink-0 text-muted" />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent sideOffset={6} className={tooltipClass}>
              {chatTypeLabel}
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
        <span className="min-w-0 flex-1 truncate">{chat.name}</span>
        {chatAdornment?.(chat.id)}
      </NavLink>
      {chat.canAdmin && (
        <Root>
          <Trigger aria-label={`Chat actions for ${chat.name}`} className={menuTriggerClass}>
            <Ellipsis aria-hidden className="size-4" />
          </Trigger>
          <Content
            align="start"
            className={menuContentClass}
            onCloseAutoFocus={(event) => openDialog === 'rename' && event.preventDefault()}
          >
            <Item className={menuItemClass} onSelect={() => setOpenDialog('rename')}>
              Rename chat
            </Item>
            <Sub>
              <SubTrigger className={menuItemClass}>Move to</SubTrigger>
              <SubContent sideOffset={4} className={menuContentClass}>
                {[...projects, { id: null, name: 'No project' }].map((project) => (
                  <Item
                    className={menuItemClass}
                    key={project.id ?? ''}
                    onSelect={() => commands.moveChat({ workspaceId, chatId: chat.id, projectId: project.id })}
                  >
                    {project.name}
                  </Item>
                ))}
              </SubContent>
            </Sub>
            <Item className={menuItemClass} onSelect={() => setOpenDialog('archive')}>
              Archive chat
            </Item>
          </Content>
        </Root>
      )}
      {openDialog === 'rename' && (
        <NameDialog
          label="Rename chat"
          fieldLabel="Chat name"
          initialName={chat.name}
          submit={(name) => commands.renameChat({ workspaceId, chatId: chat.id, name })}
          onClose={closeDialog}
        />
      )}
      {openDialog === 'archive' && (
        <Dialog label="Archive chat" subject={chat.name} onClose={closeDialog}>
          <button
            type="button"
            className={buttonClass}
            onClick={async () => {
              await commands.archiveChat({ workspaceId, chatId: chat.id })
              closeDialog()
            }}
          >
            Archive
          </button>
        </Dialog>
      )}
    </li>
  )
}
