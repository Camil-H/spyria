import { useQuery } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import { useState } from 'react'
import { Link } from 'react-router'
import { getSidebar } from '../queries/get-sidebar.ts'
import { ChatRow } from './ChatRow.tsx'
import { NewChatDialog } from './NewChatDialog.tsx'
import { NewProjectDialog } from './NewProjectDialog.tsx'
import { ProjectGroup } from './ProjectGroup.tsx'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

export const Sidebar = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const sidebar = useQuery(getSidebar(workspaceId))
  const [openDialog, setOpenDialog] = useState<'project' | 'chat' | null>(null)
  const closeDialog = () => setOpenDialog(null)
  return (
    <nav aria-label="Sidebar">
      <WorkspaceSwitcher workspaceId={workspaceId} />
      <button type="button" onClick={() => setOpenDialog('project')}>
        New project
      </button>
      <button type="button" onClick={() => setOpenDialog('chat')}>
        New chat
      </button>
      {openDialog === 'project' && <NewProjectDialog workspaceId={workspaceId} onClose={closeDialog} />}
      {openDialog === 'chat' && (
        <NewChatDialog workspaceId={workspaceId} projects={sidebar.projects} onClose={closeDialog} />
      )}
      {sidebar.projects.map((project) => (
        <ProjectGroup key={project.id} workspaceId={workspaceId} project={project} projects={sidebar.projects} />
      ))}
      <fieldset aria-label="Loose chats">
        <strong>Loose chats</strong>
        <ul>
          {sidebar.looseChats.map((chat) => (
            <ChatRow key={chat.id} workspaceId={workspaceId} chat={chat} projects={sidebar.projects} />
          ))}
        </ul>
      </fieldset>
      <Link to={`/w/${workspaceId}/profile`}>Profile</Link>
    </nav>
  )
}
