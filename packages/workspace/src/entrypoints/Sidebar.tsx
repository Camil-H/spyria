import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { ErrorMessage, useGuardedAction } from '@hq/ui'
import { Provider } from '@radix-ui/react-tooltip'
import { CircleUser, FolderPlus, Hash, Settings, SquarePen } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { NavLink } from 'react-router'
import { getSidebar } from '../queries/get-sidebar.ts'
import { listJoinableChannels } from '../queries/list-joinable-channels.ts'
import { type ChatAdornment, ChatRow } from './ChatRow.tsx'
import { IconButton } from './IconButton.tsx'
import { NameDialog } from './NameDialog.tsx'
import { NewChatDialog } from './NewChatDialog.tsx'
import { ProjectGroup } from './ProjectGroup.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { navLinkClass } from './ui.ts'
import { useWorkspacePermissions } from './useWorkspacePermissions.ts'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

const BrowseChannelsDialog = lazy(() => import('./BrowseChannelsDialog.tsx'))

export const Sidebar = ({
  workspaceId,
  chatAdornment,
}: {
  workspaceId: WorkspaceId
  chatAdornment?: ChatAdornment
}) => {
  const { memberId } = useSession()
  const sidebar = useQuery(getSidebar(workspaceId, memberId))
  const joinableChannels = useQuery(listJoinableChannels(workspaceId, memberId))
  const commands = useWorkspaceCommands()
  const hasWorkspaceSettings = useWorkspacePermissions(workspaceId).length > 0
  const chatAction = useGuardedAction()
  const [openDialog, setOpenDialog] = useState<'project' | 'chat' | 'channels' | null>(null)
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
        {openDialog === 'project' && (
          <NameDialog
            label="New project"
            fieldLabel="Project name"
            submit={(name) => commands.createProject({ workspaceId, name })}
            onClose={closeDialog}
          />
        )}
        {openDialog === 'chat' && (
          <NewChatDialog workspaceId={workspaceId} projects={sidebar.projects} onClose={closeDialog} />
        )}
        {openDialog === 'channels' && (
          <Suspense>
            <BrowseChannelsDialog workspaceId={workspaceId} channels={joinableChannels} onClose={closeDialog} />
          </Suspense>
        )}
        <div className="-m-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1 scrollbar-thin">
          {sidebar.projects.map((project) => (
            <ProjectGroup
              key={project.id}
              workspaceId={workspaceId}
              project={project}
              projects={sidebar.projects}
              chatAction={chatAction}
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
                  chatAction={chatAction}
                  chatAdornment={chatAdornment}
                />
              ))}
            </ul>
          </fieldset>
        </div>
        <ErrorMessage message={chatAction.errorMessage} />
        <div className="flex flex-col">
          <button
            type="button"
            className={navLinkClass('flex items-center gap-2 py-1.5 text-left')({ isActive: false })}
            onClick={() => setOpenDialog('channels')}
          >
            <Hash aria-hidden className="size-4" />
            <span className="flex-1">Browse channels</span>
            {joinableChannels.length > 0 && <span className="text-xs text-muted">{joinableChannels.length}</span>}
          </button>
          {hasWorkspaceSettings && (
            <NavLink to={`/w/${workspaceId}/settings`} className={navLinkClass('flex items-center gap-2 py-1.5')}>
              <Settings aria-hidden className="size-4" />
              Workspace settings
            </NavLink>
          )}
          <NavLink to={`/w/${workspaceId}/profile`} className={navLinkClass('flex items-center gap-2 py-1.5')}>
            <CircleUser aria-hidden className="size-4" />
            Profile
          </NavLink>
        </div>
      </nav>
    </Provider>
  )
}
