import { Provider } from '@radix-ui/react-tooltip'
import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { ErrorMessage, IconButton, useGuardedAction, useShortcut } from '@spyria/ui'
import { CircleUser, FolderPlus, Hash, PanelLeftClose, PanelLeftOpen, Search, Settings, SquarePen } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { getSidebar } from '../queries/get-sidebar.ts'
import { listJoinableChannels } from '../queries/list-joinable-channels.ts'
import { type ChatAdornment, ChatRow } from './ChatRow.tsx'
import { NameDialog } from './NameDialog.tsx'
import { NewChatDialog } from './NewChatDialog.tsx'
import { ProjectGroup } from './ProjectGroup.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { navLinkClass } from './ui.ts'
import { useWorkspacePermissions } from './useWorkspacePermissions.ts'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

const BrowseChannelsDialog = lazy(() => import('./BrowseChannelsDialog.tsx'))

export type SearchDialog = (props: { workspaceId: WorkspaceId; onClose: () => void }) => ReactNode
export type SidebarItem = (props: { workspaceId: WorkspaceId; isCollapsed: boolean }) => ReactNode

const collapsedStorageKey = 'spyria.sidebar-collapsed'
const headerRowClass = 'flex h-9 shrink-0 items-center'
const footerLinkClass = navLinkClass('group flex items-center gap-2 py-1.5 text-left')

const ShortcutHint = ({ shortcut }: { shortcut: string }) => (
  <kbd aria-hidden className="hidden font-sans text-xs text-muted group-hover:inline group-focus-visible:inline">
    {shortcut}
  </kbd>
)

const storedCollapsed = () => {
  try {
    return localStorage.getItem(collapsedStorageKey) === 'true'
  } catch {
    return false
  }
}

const useCollapsed = () => {
  const [isCollapsed, setIsCollapsed] = useState(storedCollapsed)
  const toggleCollapsed = () => {
    setIsCollapsed(!isCollapsed)
    try {
      localStorage.setItem(collapsedStorageKey, String(!isCollapsed))
    } catch {}
  }
  return { isCollapsed, toggleCollapsed }
}

export const Sidebar = ({
  workspaceId,
  chatAdornment,
  searchDialog,
  topItem,
}: {
  workspaceId: WorkspaceId
  chatAdornment?: ChatAdornment
  searchDialog?: SearchDialog
  topItem?: SidebarItem
}) => {
  const { memberId } = useSession()
  const sidebar = useQuery(getSidebar, workspaceId, memberId)
  const joinableChannels = useQuery(listJoinableChannels, workspaceId, memberId)
  const commands = useWorkspaceCommands()
  const navigate = useNavigate()
  const hasWorkspaceSettings = useWorkspacePermissions(workspaceId).length > 0
  const chatAction = useGuardedAction()
  const [openDialog, setOpenDialog] = useState<'project' | 'chat' | 'channels' | 'search' | null>(null)
  const closeDialog = () => setOpenDialog(null)
  const { isCollapsed, toggleCollapsed } = useCollapsed()
  const toggleLabel = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
  useShortcut('l', toggleLabel, toggleCollapsed)
  useShortcut('/', 'Search the workspace', () => setOpenDialog('search'), searchDialog !== undefined)
  useShortcut('c', 'New chat', () => setOpenDialog('chat'))
  useShortcut('p', 'New project', () => setOpenDialog('project'))
  useShortcut('b', 'Browse channels', () => setOpenDialog('channels'))
  useShortcut('s', 'Workspace settings', () => navigate(`/w/${workspaceId}/settings`), hasWorkspaceSettings)
  useShortcut('i', 'Profile', () => navigate(`/w/${workspaceId}/profile`))
  const dialogs = (
    <>
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
      {openDialog === 'search' && searchDialog?.({ workspaceId, onClose: closeDialog })}
    </>
  )
  if (isCollapsed)
    return (
      <Provider delayDuration={300}>
        <nav aria-label="Sidebar" className="flex h-full shrink-0 flex-col gap-3 border-r border-line bg-sidebar p-3">
          <div className={headerRowClass}>
            <IconButton label={toggleLabel} shortcut="l" icon={PanelLeftOpen} onClick={toggleCollapsed} />
          </div>
          {topItem?.({ workspaceId, isCollapsed })}
          {dialogs}
        </nav>
      </Provider>
    )
  return (
    <Provider delayDuration={300}>
      <nav
        aria-label="Sidebar"
        className="flex h-full w-64 shrink-0 flex-col gap-3 border-r border-line bg-sidebar p-3"
      >
        <div className={`${headerRowClass} justify-between gap-2`}>
          <IconButton label={toggleLabel} shortcut="l" icon={PanelLeftClose} onClick={toggleCollapsed} />
          <WorkspaceSwitcher workspaceId={workspaceId} />
          <div className="flex shrink-0 gap-1">
            <IconButton label="New project" shortcut="p" icon={FolderPlus} onClick={() => setOpenDialog('project')} />
            <IconButton label="New chat" shortcut="c" icon={SquarePen} onClick={() => setOpenDialog('chat')} />
          </div>
        </div>
        {topItem?.({ workspaceId, isCollapsed })}
        {searchDialog && (
          <button
            type="button"
            aria-keyshortcuts="/"
            className={`${footerLinkClass({ isActive: false })} -mb-1 border border-line bg-raised`}
            onClick={() => setOpenDialog('search')}
          >
            <Search aria-hidden className="size-4" />
            <span className="flex-1 text-muted">Search</span>
            <kbd aria-hidden className="font-sans text-xs text-muted">
              /
            </kbd>
          </button>
        )}
        {dialogs}
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
            aria-keyshortcuts="B"
            className={footerLinkClass({ isActive: false })}
            onClick={() => setOpenDialog('channels')}
          >
            <Hash aria-hidden className="size-4" />
            <span className="flex-1">Browse channels</span>
            <ShortcutHint shortcut="B" />
            {joinableChannels.length > 0 && <span className="text-xs text-muted">{joinableChannels.length}</span>}
          </button>
          {hasWorkspaceSettings && (
            <NavLink to={`/w/${workspaceId}/settings`} aria-keyshortcuts="S" className={footerLinkClass}>
              <Settings aria-hidden className="size-4" />
              <span className="flex-1">Workspace settings</span>
              <ShortcutHint shortcut="S" />
            </NavLink>
          )}
          <NavLink to={`/w/${workspaceId}/profile`} aria-keyshortcuts="I" className={footerLinkClass}>
            <CircleUser aria-hidden className="size-4" />
            <span className="flex-1">Profile</span>
            <ShortcutHint shortcut="I" />
          </NavLink>
        </div>
      </nav>
    </Provider>
  )
}
