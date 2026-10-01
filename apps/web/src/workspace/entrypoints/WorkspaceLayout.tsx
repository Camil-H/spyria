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
    <div style={{ display: 'flex', gap: '1rem' }}>
      <Sidebar workspaceId={workspaceId} />
      <main>
        <Outlet context={workspaceId} />
      </main>
    </div>
  )
}
