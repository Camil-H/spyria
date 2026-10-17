import type { WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, focusRing, menuContentClass } from '@hq/ui'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'
import type { ChatsPolicy } from '../domain/project.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { type ChatAdornment, ChatRow } from './ChatRow.tsx'
import { NameDialog } from './NameDialog.tsx'
import { useWorkspaceCommands } from './providers.tsx'
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
  const [openDialog, setOpenDialog] = useState<'rename' | 'archive' | null>(null)
  const closeDialog = () => setOpenDialog(null)
  const archiveWith = async (chatsPolicy: ChatsPolicy) => {
    await commands.archiveProject({ workspaceId, projectId: project.id, chatsPolicy })
    closeDialog()
  }
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
            onCloseAutoFocus={(event) => openDialog === 'rename' && event.preventDefault()}
          >
            <Item className={menuItemClass} onSelect={() => setOpenDialog('rename')}>
              Rename project
            </Item>
            <Item className={menuItemClass} onSelect={() => setOpenDialog('archive')}>
              Archive project
            </Item>
          </Content>
        </Root>
      </div>
      {openDialog === 'rename' && (
        <NameDialog
          label="Rename project"
          fieldLabel="Project name"
          initialName={project.name}
          submit={(name) => commands.renameProject({ workspaceId, projectId: project.id, name })}
          onClose={closeDialog}
        />
      )}
      {openDialog === 'archive' && (
        <Dialog label="Archive project" subject={project.name} onClose={closeDialog}>
          {project.chats.every((chat) => chat.canAdmin) && (
            <button type="button" className={buttonClass} onClick={() => archiveWith('archive')}>
              Archive with its chats
            </button>
          )}
          <button type="button" className={buttonClass} onClick={() => archiveWith('release')}>
            Archive, keep chats
          </button>
        </Dialog>
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
