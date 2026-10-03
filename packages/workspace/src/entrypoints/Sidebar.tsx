import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { focusRing } from '@hq/ui'
import { Provider } from '@radix-ui/react-tooltip'
import { FolderPlus, SquarePen } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router'
import { getSidebar } from '../queries/get-sidebar.ts'
import { type ChatAdornment, ChatRow } from './ChatRow.tsx'
import { IconButton } from './IconButton.tsx'
import { NewChatDialog } from './NewChatDialog.tsx'
import { NewProjectDialog } from './NewProjectDialog.tsx'
import { ProjectGroup } from './ProjectGroup.tsx'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

export const Sidebar = ({
  workspaceId,
  chatAdornment,
}: {
  workspaceId: WorkspaceId
  chatAdornment?: ChatAdornment
}) => {
  const sidebar = useQuery(getSidebar(workspaceId))
  const [openDialog, setOpenDialog] = useState<'project' | 'chat' | null>(null)
  const closeDialog = () => setOpenDialog(null)
  return (
    <Provider delayDuration={300}>
      <nav
        aria-label="Sidebar"
        className="flex h-full w-64 shrink-0 flex-col gap-3 border-r border-line bg-sidebar p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <WorkspaceSwitcher workspaceId={workspaceId} />
          <div className="flex shrink-0 gap-1">
            <IconButton label="New project" icon={FolderPlus} onClick={() => setOpenDialog('project')} />
            <IconButton label="New chat" icon={SquarePen} onClick={() => setOpenDialog('chat')} />
          </div>
        </div>
        {openDialog === 'project' && <NewProjectDialog workspaceId={workspaceId} onClose={closeDialog} />}
        {openDialog === 'chat' && (
          <NewChatDialog workspaceId={workspaceId} projects={sidebar.projects} onClose={closeDialog} />
        )}
        <div className="-m-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1 scrollbar-thin">
          {sidebar.projects.map((project) => (
            <ProjectGroup
              key={project.id}
              workspaceId={workspaceId}
              project={project}
              projects={sidebar.projects}
              chatAdornment={chatAdornment}
            />
          ))}
          <fieldset aria-label="Loose chats" className="m-0 min-w-0 border-0 p-0">
            <strong className="block px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">
              Loose chats
            </strong>
            <ul className="flex flex-col">
              {sidebar.looseChats.map((chat) => (
                <ChatRow
                  key={chat.id}
                  workspaceId={workspaceId}
                  chat={chat}
                  projects={sidebar.projects}
                  chatAdornment={chatAdornment}
                />
              ))}
            </ul>
          </fieldset>
        </div>
        <NavLink
          to={`/w/${workspaceId}/profile`}
          className={({ isActive }) =>
            `rounded-md px-2 py-1.5 text-sm ${focusRing} ${isActive ? 'bg-selected font-medium' : 'hover:bg-hover'}`
          }
        >
          Profile
        </NavLink>
      </nav>
    </Provider>
  )
}
