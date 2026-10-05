import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, Dialog, focusRing, menuContentClass } from '@hq/ui'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { LogOut, Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { listWorkspaces } from '../queries/list-workspaces.ts'
import { NameDialog } from './NameDialog.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { menuItemClass } from './ui.ts'

type OpenDialog = { kind: 'new' } | { kind: 'logOut'; workspaceId: WorkspaceId; workspaceName: string } | null

export const WorkspaceSwitcher = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const navigate = useNavigate()
  const commands = useWorkspaceCommands()
  const { memberId, signedInWorkspaceIds, signOut } = useSession()
  const workspaces = useQuery(listWorkspaces(memberId))
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null)
  const closeDialog = () => setOpenDialog(null)
  return (
    <>
      <Root>
        <Trigger
          aria-label="Switch workspace"
          className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left font-semibold hover:bg-hover data-[state=open]:bg-hover ${focusRing}`}
        >
          {workspaces.find((workspace) => workspace.id === workspaceId)?.name}
        </Trigger>
        <Content
          align="start"
          sideOffset={4}
          className={menuContentClass}
          onCloseAutoFocus={(event) => openDialog && event.preventDefault()}
        >
          <Item className={`${menuItemClass} justify-start gap-2`} onSelect={() => setOpenDialog({ kind: 'new' })}>
            <Plus aria-hidden className="size-4" />
            New workspace
          </Item>
          {workspaces.map((workspace) => (
            <div key={workspace.id} className="flex items-center gap-1">
              <Item className={`${menuItemClass} flex-1 gap-4`} onSelect={() => navigate(`/w/${workspace.id}`)}>
                {workspace.name}
                {!signedInWorkspaceIds.has(workspace.id) && <span className="text-muted">Signed out</span>}
              </Item>
              {signedInWorkspaceIds.has(workspace.id) && (
                <Item
                  aria-label={`Log out of ${workspace.name}`}
                  className={`${menuItemClass} p-1.5`}
                  onSelect={() =>
                    setOpenDialog({ kind: 'logOut', workspaceId: workspace.id, workspaceName: workspace.name })
                  }
                >
                  <LogOut aria-hidden className="size-4" />
                </Item>
              )}
            </div>
          ))}
        </Content>
      </Root>
      {openDialog?.kind === 'new' && (
        <NameDialog
          label="New workspace"
          fieldLabel="Workspace name"
          submit={async (name) => navigate(`/w/${await commands.createWorkspace({ workspaceId, name })}`)}
          onClose={closeDialog}
        />
      )}
      {openDialog?.kind === 'logOut' && (
        <Dialog label={`Log out of ${openDialog.workspaceName}`} onClose={closeDialog}>
          <p className="text-sm text-muted">
            You will need to sign in again to use this workspace. Nothing is removed and you stay a member.
          </p>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              signOut(openDialog.workspaceId)
              closeDialog()
            }}
          >
            Log out
          </button>
        </Dialog>
      )}
    </>
  )
}
