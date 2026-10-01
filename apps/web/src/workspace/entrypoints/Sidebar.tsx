import { useQuery } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import { useState } from 'react'
import { NavLink } from 'react-router'
import { getSidebar } from '../queries/get-sidebar.ts'
import { ChatRow } from './ChatRow.tsx'
import { NewChatDialog } from './NewChatDialog.tsx'
import { NewProjectDialog } from './NewProjectDialog.tsx'
import { ProjectGroup } from './ProjectGroup.tsx'
import { buttonClass, focusRing, ghostButtonClass } from './ui.ts'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

export const Sidebar = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const sidebar = useQuery(getSidebar(workspaceId))
  const [openDialog, setOpenDialog] = useState<'project' | 'chat' | null>(null)
  const closeDialog = () => setOpenDialog(null)
  return (
    <nav aria-label="Sidebar" className="flex h-full w-64 shrink-0 flex-col gap-3 border-r border-line bg-sidebar p-3">
      <WorkspaceSwitcher workspaceId={workspaceId} />
      <div className="flex gap-2">
        <button type="button" className={ghostButtonClass} onClick={() => setOpenDialog('project')}>
          New project
        </button>
        <button type="button" className={buttonClass} onClick={() => setOpenDialog('chat')}>
          New chat
        </button>
      </div>
      {openDialog === 'project' && <NewProjectDialog workspaceId={workspaceId} onClose={closeDialog} />}
      {openDialog === 'chat' && (
        <NewChatDialog workspaceId={workspaceId} projects={sidebar.projects} onClose={closeDialog} />
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scrollbar-thin">
        {sidebar.projects.map((project) => (
          <ProjectGroup key={project.id} workspaceId={workspaceId} project={project} projects={sidebar.projects} />
        ))}
        <fieldset aria-label="Loose chats" className="m-0 min-w-0 border-0 p-0">
          <strong className="block px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">
            Loose chats
          </strong>
          <ul className="flex flex-col">
            {sidebar.looseChats.map((chat) => (
              <ChatRow key={chat.id} workspaceId={workspaceId} chat={chat} projects={sidebar.projects} />
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
  )
}
