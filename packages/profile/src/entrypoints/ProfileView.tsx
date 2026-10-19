import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import type { ReactNode } from 'react'
import { useOutletContext } from 'react-router'
import { getProfile } from '../queries/get-profile.ts'
import { ConnectionsSection } from './ConnectionsSection.tsx'
import { DisplayNameForm } from './DisplayNameForm.tsx'
import { LlmAccessSection } from './LlmAccessSection.tsx'

export const ProfileView = ({ children }: { children?: ReactNode }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const displayName = useQuery(getProfile(workspaceId, memberId))
  if (!displayName) return null
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <h1 className="text-2xl font-semibold">Profile</h1>
      <DisplayNameForm workspaceId={workspaceId} currentName={displayName} />
      <LlmAccessSection workspaceId={workspaceId} memberId={memberId} />
      <ConnectionsSection workspaceId={workspaceId} memberId={memberId} />
      {children}
    </div>
  )
}
