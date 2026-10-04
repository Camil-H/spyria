import type { MemberId, WorkspaceId } from '@hq/kernel'
import { createContext, type ReactNode, use, useSyncExternalStore } from 'react'

export type Session = {
  memberId: MemberId
  defaultWorkspaceId: WorkspaceId
  signedInWorkspaceIds: () => ReadonlySet<WorkspaceId>
  subscribe: (listener: () => void) => () => void
  signOut: (workspaceId: WorkspaceId) => Promise<void>
  signIn: (workspaceId: WorkspaceId) => Promise<void>
}

type SessionState = Omit<Session, 'signedInWorkspaceIds' | 'subscribe'> & {
  signedInWorkspaceIds: ReadonlySet<WorkspaceId>
}

const SessionContext = createContext<SessionState | null>(null)

export const SessionProvider = ({ session, children }: { session: Session; children: ReactNode }) => {
  const signedInWorkspaceIds = useSyncExternalStore(session.subscribe, session.signedInWorkspaceIds)
  return <SessionContext value={{ ...session, signedInWorkspaceIds }}>{children}</SessionContext>
}

export const useSession = () => {
  const session = use(SessionContext)
  if (!session) throw new Error('SessionProvider is missing')
  return session
}
