import type { MemberId, WorkspaceId } from '@hq/kernel'
import { createContext, type ReactNode, use } from 'react'

export type Session = { memberId: MemberId; defaultWorkspaceId: WorkspaceId }

const SessionContext = createContext<Session | null>(null)

export const SessionProvider = ({ session, children }: { session: Session; children: ReactNode }) => (
  <SessionContext value={session}>{children}</SessionContext>
)

export const useSession = () => {
  const session = use(SessionContext)
  if (!session) throw new Error('SessionProvider is missing')
  return session
}
