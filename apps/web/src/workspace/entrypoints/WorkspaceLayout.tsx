import { useQuery } from '@hq/db'
import { Navigate, Outlet, useParams } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { listWorkspaces } from '../queries/list-workspaces.ts'
import type { ChatAdornment } from './ChatRow.tsx'
import { Sidebar } from './Sidebar.tsx'
import { SignedOutScreen } from './SignedOutScreen.tsx'

export const WorkspaceLayout = ({ chatAdornment }: { chatAdornment?: ChatAdornment }) => {
  const { memberId, defaultWorkspaceId, signedOutWorkspaceIds } = useSession()
  const routeWorkspaceId = useParams().workspaceId
  const workspaces = useQuery(listWorkspaces(memberId))
  const workspaceId = workspaces.find((workspace) => workspace.id === routeWorkspaceId)?.id
  if (!workspaceId) return <Navigate to={`/w/${defaultWorkspaceId}`} replace />
  if (signedOutWorkspaceIds.has(workspaceId)) return <SignedOutScreen workspaceId={workspaceId} />
  return (
    <div className="flex h-screen">
      <Sidebar workspaceId={workspaceId} chatAdornment={chatAdornment} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet context={workspaceId} />
      </main>
    </div>
  )
}
