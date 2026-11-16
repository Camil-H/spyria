import { Content, Item, Root, Sub, SubContent, SubTrigger, Trigger } from '@radix-ui/react-dropdown-menu'
import {
  Content as TooltipContent,
  Portal as TooltipPortal,
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
} from '@radix-ui/react-tooltip'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  chatTypeIconOf,
  Dialog,
  menuContentClass,
  menuItemClass,
  tooltipClass,
  type useGuardedAction,
  useNotifiedRun,
} from '@spyria/ui'
import { Ellipsis } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { NavLink } from 'react-router'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { NameDialog } from './NameDialog.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { menuTriggerClass, navLinkClass } from './ui.ts'
import { type ChatGroup, chatDragHandlers, useChatRowDrop } from './useChatDrop.ts'

type SidebarChat = Sidebar['looseChats'][number]
export type ChatAdornment = (chatId: ChatId) => ReactNode
export type ChatAction = ReturnType<typeof useGuardedAction>

export const ChatRow = ({
  workspaceId,
  chat,
  group,
  projects,
  chatAction,
  chatAdornment,
}: {
  workspaceId: WorkspaceId
  chat: SidebarChat
  group: ChatGroup
  projects: Sidebar['projects']
  chatAction: ChatAction
  chatAdornment?: ChatAdornment
}) => {
  const commands = useWorkspaceCommands()
  const runNotified = useNotifiedRun(chatAction.run)
  const isPublic = chat.visibility === 'public'
  const [openDialog, setOpenDialog] = useState<'rename' | 'archive' | null>(null)
  const closeDialog = () => setOpenDialog(null)
  const { Icon: ChatTypeIcon, label: chatTypeLabel } = chatTypeIconOf(chat.type)
  const chatTypeId = useId()
  const indicatorsId = useId()
  const { placement: dropPlacement, ...rowDrop } = useChatRowDrop(chat.id, { workspaceId, group, chatAction })
  return (
    <li {...rowDrop} {...chatDragHandlers(chat)} className="relative flex items-center">
      {dropPlacement && (
        <span
          aria-hidden
          data-drop-placement={dropPlacement}
          className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-focus ${dropPlacement === 'before' ? '-top-px' : '-bottom-px'}`}
        />
      )}
      <NavLink
        to={`/w/${workspaceId}/chats/${chat.id}`}
        aria-label={chat.name}
        aria-describedby={`${chatTypeId} ${indicatorsId}`}
        className={navLinkClass('flex min-w-0 flex-1 items-center gap-2 py-1')}
      >
        <TooltipRoot disableHoverableContent>
          <TooltipTrigger asChild>
            <ChatTypeIcon
              id={chatTypeId}
              aria-label={chatTypeLabel}
              role="img"
              size={14}
              className="shrink-0 text-muted"
            />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent sideOffset={6} className={tooltipClass}>
              {chatTypeLabel}
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
        <span className="min-w-0 flex-1 truncate">{chat.name}</span>
        <span id={indicatorsId} className="flex shrink-0 items-center gap-2 empty:hidden">
          {chatAdornment?.(chat.id)}
        </span>
      </NavLink>
      <Root>
        <Trigger aria-label={`Chat actions for ${chat.name}`} className={menuTriggerClass}>
          <Ellipsis aria-hidden className="size-4" />
        </Trigger>
        <Content align="start" className={menuContentClass}>
          {chat.canAdmin && (
            <>
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
                      onSelect={() =>
                        runNotified(
                          () => commands.moveChat({ workspaceId, chatId: chat.id, projectId: project.id }),
                          project.id
                            ? `${chat.name} moved to ${project.name}`
                            : `${chat.name} is no longer in a project`,
                        )
                      }
                    >
                      {project.name}
                    </Item>
                  ))}
                </SubContent>
              </Sub>
              <Item
                className={menuItemClass}
                disabled={chatAction.isPending}
                onSelect={() =>
                  runNotified(
                    () =>
                      commands.changeVisibility({
                        workspaceId,
                        chatId: chat.id,
                        visibility: isPublic ? 'private' : 'public',
                      }),
                    isPublic
                      ? `${chat.name} is now private: only its members can see it`
                      : `${chat.name} is now public: anyone in the workspace can find and join it`,
                  )
                }
              >
                {isPublic ? 'Make private' : 'Make public'}
              </Item>
              <Item className={menuItemClass} onSelect={() => setOpenDialog('archive')}>
                Archive chat
              </Item>
            </>
          )}
          {chat.canLeave && (
            <Item
              className={menuItemClass}
              disabled={chatAction.isPending}
              onSelect={() =>
                runNotified(() => commands.leaveChat({ workspaceId, chatId: chat.id }), `You left ${chat.name}`)
              }
            >
              {chat.type === 'channel' ? 'Leave channel' : 'Leave chat'}
            </Item>
          )}
        </Content>
      </Root>
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
            data-initial-focus
            className={buttonClass}
            disabled={chatAction.isPending}
            onClick={async () => {
              await runNotified(() => commands.archiveChat({ workspaceId, chatId: chat.id }), `${chat.name} archived`)
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
