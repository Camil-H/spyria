import { useQuery } from '@hq/db'
import { Navigate, Outlet, useParams } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { listWorkspaces } from '../queries/list-workspaces.ts'
import { Sidebar } from './Sidebar.tsx'

export const WorkspaceLayout = () => {
  const { memberId, defaultWorkspaceId } = useSession()
  const routeWorkspaceId = useParams().workspaceId
  const workspaces = useQuery(listWorkspaces(memberId))
  const workspaceId = workspaces.find((workspace) => workspace.id === routeWorkspaceId)?.id
  if (!workspaceId) return <Navigate to={`/w/${defaultWorkspaceId}`} replace />
  return (
    <div className="flex h-screen">
      <Sidebar workspaceId={workspaceId} />
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <Outlet context={workspaceId} />
      </main>
    </div>
  )
}
