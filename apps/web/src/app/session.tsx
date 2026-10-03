import type { MemberId, WorkspaceId } from '@hq/kernel'
import { createContext, type ReactNode, use, useState } from 'react'

export type Session = { memberId: MemberId; defaultWorkspaceId: WorkspaceId }

type SessionState = Session & {
  signedOutWorkspaceIds: ReadonlySet<WorkspaceId>
  signOut: (workspaceId: WorkspaceId) => void
  signIn: (workspaceId: WorkspaceId) => void
}

const SessionContext = createContext<SessionState | null>(null)

export const SessionProvider = ({ session, children }: { session: Session; children: ReactNode }) => {
  const [signedOutWorkspaceIds, setSignedOutWorkspaceIds] = useState<ReadonlySet<WorkspaceId>>(new Set())
  const signOut = (workspaceId: WorkspaceId) => setSignedOutWorkspaceIds((current) => new Set(current).add(workspaceId))
  const signIn = (workspaceId: WorkspaceId) =>
    setSignedOutWorkspaceIds((current) => {
      const next = new Set(current)
      next.delete(workspaceId)
      return next
    })
  return <SessionContext value={{ ...session, signedOutWorkspaceIds, signOut, signIn }}>{children}</SessionContext>
}

export const useSession = () => {
  const session = use(SessionContext)
  if (!session) throw new Error('SessionProvider is missing')
  return session
}
