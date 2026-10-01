import type { WorkspaceId } from '@hq/kernel'
import { Content, Item, Root, Sub, SubContent, SubTrigger, Trigger } from '@radix-ui/react-dropdown-menu'
import { Link } from 'react-router'
import { moveChat } from '../operations/move-chat.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceDependencies } from './providers.tsx'

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
    <li>
      <Link to={`/w/${workspaceId}/chats/${chat.id}`}>
        {chat.name}{' '}
        <small>
          {chat.type} · {chat.ownerName}
        </small>
      </Link>
      <Root>
        <Trigger aria-label={`Chat actions for ${chat.name}`}>...</Trigger>
        <Content>
          <Sub>
            <SubTrigger>Move to</SubTrigger>
            <SubContent>
              {projects.map((project) => (
                <Item
                  key={project.id}
                  onSelect={() => moveChat(dependencies, { chatId: chat.id, projectId: project.id })}
                >
                  {project.name}
                </Item>
              ))}
              <Item onSelect={() => moveChat(dependencies, { chatId: chat.id, projectId: null })}>No project</Item>
            </SubContent>
          </Sub>
        </Content>
      </Root>
    </li>
  )
}
