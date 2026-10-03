import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, focusRing } from '@hq/ui'
import { Link } from 'react-router'
import { listWorkspaces } from '../queries/list-workspaces.ts'

export const SignedOutScreen = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const { memberId, signedOutWorkspaceIds, signIn } = useSession()
  const workspaces = useQuery(listWorkspaces(memberId))
  const signedOutName = workspaces.find((workspace) => workspace.id === workspaceId)?.name
  const otherWorkspaces = workspaces.filter(
    (workspace) => workspace.id !== workspaceId && !signedOutWorkspaceIds.has(workspace.id),
  )
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-app p-6 text-center text-ink">
      <p className="text-xl font-medium">You are signed out of {signedOutName}</p>
      <button type="button" className={buttonClass} onClick={() => signIn(workspaceId)}>
        Sign in
      </button>
      {otherWorkspaces.length === 0 ? (
        <p className="text-sm text-muted">You have no other signed-in workspace.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {otherWorkspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link to={`/w/${workspace.id}`} className={`rounded-md px-2 py-1 underline ${focusRing}`}>
                Go to {workspace.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
