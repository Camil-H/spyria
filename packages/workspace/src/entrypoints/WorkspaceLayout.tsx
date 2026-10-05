import { useQuery } from '@hq/db/react'
import { useSession } from '@hq/session'
import { Outlet, useParams } from 'react-router'
import { listWorkspaces } from '../queries/list-workspaces.ts'
import type { ChatAdornment } from './ChatRow.tsx'
import { NoAccessScreen } from './NoAccessScreen.tsx'
import { Sidebar } from './Sidebar.tsx'
import { SignedOutScreen } from './SignedOutScreen.tsx'

export const WorkspaceLayout = ({ chatAdornment }: { chatAdornment?: ChatAdornment }) => {
  const { memberId, signedInWorkspaceIds } = useSession()
  const routeWorkspaceId = useParams().workspaceId
  const workspaces = useQuery(listWorkspaces(memberId))
  const workspaceId = workspaces.find((workspace) => workspace.id === routeWorkspaceId)?.id
  if (!workspaceId) return <NoAccessScreen />
  if (!signedInWorkspaceIds.has(workspaceId))
    return <SignedOutScreen workspaceId={workspaceId} workspaces={workspaces} />
  return (
    <div className="flex h-screen">
      <Sidebar workspaceId={workspaceId} chatAdornment={chatAdornment} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet context={workspaceId} />
      </main>
    </div>
  )
}
