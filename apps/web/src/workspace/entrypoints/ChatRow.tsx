import type { WorkspaceId } from '@hq/kernel'
import { Content, Item, Root, Sub, SubContent, SubTrigger, Trigger } from '@radix-ui/react-dropdown-menu'
import { NavLink } from 'react-router'
import { moveChat } from '../operations/move-chat.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceDependencies } from './providers.tsx'
import { focusRing, menuContentClass, menuItemClass, menuTriggerClass } from './ui.ts'

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
  return (
    <li className="flex items-center">
      <NavLink
        to={`/w/${workspaceId}/chats/${chat.id}`}
        className={({ isActive }) =>
          `flex min-w-0 flex-1 flex-col rounded-md px-2 py-1 text-sm ${focusRing} ${isActive ? 'bg-selected font-medium' : 'hover:bg-hover'}`
        }
      >
        <span className="truncate">{chat.name}</span>{' '}
        <small className="flex items-center gap-1.5 text-xs font-normal text-muted">
          <span className="rounded-full border border-line px-1.5">{chat.type}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{chat.ownerName}</span>
        </small>
      </NavLink>
      <Root>
        <Trigger aria-label={`Chat actions for ${chat.name}`} className={menuTriggerClass}>
          ...
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
