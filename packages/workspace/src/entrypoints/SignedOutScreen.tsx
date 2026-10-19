import type { Snapshot } from '@spyria/db'
import type { WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { buttonClass, focusRing } from '@spyria/ui'
import { Link } from 'react-router'
import { fullScreenClass } from './ui.ts'

export const SignedOutScreen = ({
  workspaceId,
  workspaces,
}: {
  workspaceId: WorkspaceId
  workspaces: Snapshot['workspaces']
}) => {
  const { signedInWorkspaceIds, signIn } = useSession()
  const signedOutName = workspaces.find((workspace) => workspace.id === workspaceId)?.name
  const otherWorkspaces = workspaces.filter(
    (workspace) => workspace.id !== workspaceId && signedInWorkspaceIds.has(workspace.id),
  )
  return (
    <main className={fullScreenClass}>
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
