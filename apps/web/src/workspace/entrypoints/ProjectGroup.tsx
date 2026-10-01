import type { WorkspaceId } from '@hq/kernel'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { ArchiveProjectDialog } from './ArchiveProjectDialog.tsx'
import { ChatRow } from './ChatRow.tsx'
import { focusRing, menuContentClass, menuItemClass, menuTriggerClass } from './ui.ts'

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
    <fieldset aria-label={project.name} className="m-0 min-w-0 border-0 p-0">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded(!isExpanded)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm font-medium hover:bg-hover ${focusRing} aria-expanded:[&>span:first-child]:rotate-90`}
        >
          <span aria-hidden className="text-xs text-muted transition-transform">
            ▸
          </span>
          <span className="truncate">{project.name}</span>
        </button>
        <Root>
          <Trigger aria-label={`Project actions for ${project.name}`} className={menuTriggerClass}>
            <Ellipsis aria-hidden className="size-4" />
          </Trigger>
          <Content align="start" className={menuContentClass}>
            <Item className={menuItemClass} onSelect={() => setIsArchiving(true)}>
              Archive project
            </Item>
          </Content>
        </Root>
      </div>
      {isArchiving && <ArchiveProjectDialog projectId={project.id} onClose={() => setIsArchiving(false)} />}
      {isExpanded && (
        <ul className="ml-3 flex flex-col border-l border-line pl-1">
          {project.chats.map((chat) => (
            <ChatRow key={chat.id} workspaceId={workspaceId} chat={chat} projects={projects} />
          ))}
        </ul>
      )}
    </fieldset>
  )
}
