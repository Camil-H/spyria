import type { WorkspaceId } from '@hq/kernel'
import { focusRing, menuContentClass } from '@hq/ui'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { ArchiveProjectDialog } from './ArchiveProjectDialog.tsx'
import { type ChatAdornment, ChatRow } from './ChatRow.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { RenameDialog } from './RenameDialog.tsx'
import { menuItemClass, menuTriggerClass } from './ui.ts'

export const ProjectGroup = ({
  workspaceId,
  project,
  projects,
  chatAdornment,
}: {
  workspaceId: WorkspaceId
  project: Sidebar['projects'][number]
  projects: Sidebar['projects']
  chatAdornment?: ChatAdornment
}) => {
  const [isExpanded, setIsExpanded] = useState(true)
  const commands = useWorkspaceCommands()
  const [isRenaming, setIsRenaming] = useState(false)
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
          <Content
            align="start"
            className={menuContentClass}
            onCloseAutoFocus={(event) => isRenaming && event.preventDefault()}
          >
            <Item className={menuItemClass} onSelect={() => setIsRenaming(true)}>
              Rename project
            </Item>
            <Item className={menuItemClass} onSelect={() => setIsArchiving(true)}>
              Archive project
            </Item>
          </Content>
        </Root>
      </div>
      {isRenaming && (
        <RenameDialog
          label="Rename project"
          fieldLabel="Project name"
          currentName={project.name}
          rename={(name) => commands.renameProject({ workspaceId, projectId: project.id, name })}
          onClose={() => setIsRenaming(false)}
        />
      )}
      {isArchiving && (
        <ArchiveProjectDialog
          workspaceId={workspaceId}
          projectId={project.id}
          projectName={project.name}
          onClose={() => setIsArchiving(false)}
        />
      )}
      {isExpanded && (
        <ul className="ml-3 flex flex-col border-l border-line pl-1">
          {project.chats.map((chat) => (
            <ChatRow
              key={chat.id}
              workspaceId={workspaceId}
              chat={chat}
              projects={projects}
              chatAdornment={chatAdornment}
            />
          ))}
        </ul>
      )}
    </fieldset>
  )
}
