import type { WorkspaceId } from '@hq/kernel'
import { Content, Item, Root, Sub, SubContent, SubTrigger, Trigger } from '@radix-ui/react-dropdown-menu'
import {
  Content as TooltipContent,
  Portal as TooltipPortal,
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
} from '@radix-ui/react-tooltip'
import { Bot, Ellipsis, Hash } from 'lucide-react'
import { NavLink } from 'react-router'
import { moveChat } from '../operations/move-chat.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceDependencies } from './providers.tsx'
import { focusRing, menuContentClass, menuItemClass, menuTriggerClass, tooltipClass } from './ui.ts'

type SidebarChat = Sidebar['looseChats'][number]

export const ChatRow = ({
  workspaceId,
  chat,
  projects,
}: {
  workspaceId: WorkspaceId
  chat: SidebarChat
  projects: Sidebar['projects']
}) => {
  const dependencies = useWorkspaceDependencies()
  const ChatTypeIcon = chat.type === 'channel' ? Hash : Bot
  const chatTypeLabel = chat.type === 'channel' ? 'Channel' : 'Runtime chat'
  return (
    <li className="flex items-center">
      <NavLink
        to={`/w/${workspaceId}/chats/${chat.id}`}
        className={({ isActive }) =>
          `flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm ${focusRing} ${isActive ? 'bg-selected font-medium' : 'hover:bg-hover'}`
        }
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
        <span className="min-w-0 truncate">{chat.name}</span>
      </NavLink>
      <Root>
        <Trigger aria-label={`Chat actions for ${chat.name}`} className={menuTriggerClass}>
          <Ellipsis aria-hidden className="size-4" />
        </Trigger>
        <Content align="start" className={menuContentClass}>
          <Sub>
            <SubTrigger className={menuItemClass}>Move to</SubTrigger>
            <SubContent sideOffset={4} className={menuContentClass}>
              {projects.map((project) => (
                <Item
                  className={menuItemClass}
                  key={project.id}
                  onSelect={() => moveChat(dependencies, { chatId: chat.id, projectId: project.id })}
                >
                  {project.name}
                </Item>
              ))}
              <Item
                className={menuItemClass}
                onSelect={() => moveChat(dependencies, { chatId: chat.id, projectId: null })}
              >
                No project
              </Item>
            </SubContent>
          </Sub>
        </Content>
      </Root>
    </li>
  )
}
