import type { WorkspaceId } from '@hq/kernel'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { useState } from 'react'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { ArchiveProjectDialog } from './ArchiveProjectDialog.tsx'
import { ChatRow } from './ChatRow.tsx'

export const ProjectGroup = ({
  workspaceId,
  project,
  projects,
}: {
  workspaceId: WorkspaceId
  project: Sidebar['projects'][number]
  projects: Sidebar['projects']
}) => {
  const [isExpanded, setIsExpanded] = useState(true)
  const [isArchiving, setIsArchiving] = useState(false)
  return (
    <fieldset aria-label={project.name}>
      <button type="button" aria-expanded={isExpanded} onClick={() => setIsExpanded(!isExpanded)}>
        {project.name}
      </button>
      <Root>
        <Trigger aria-label={`Project actions for ${project.name}`}>...</Trigger>
        <Content>
          <Item onSelect={() => setIsArchiving(true)}>Archive project</Item>
        </Content>
      </Root>
      {isArchiving && <ArchiveProjectDialog projectId={project.id} onClose={() => setIsArchiving(false)} />}
      {isExpanded && (
        <ul>
          {project.chats.map((chat) => (
            <ChatRow key={chat.id} workspaceId={workspaceId} chat={chat} projects={projects} />
          ))}
        </ul>
      )}
    </fieldset>
  )
}
