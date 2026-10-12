import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import type { ReactNode } from 'react'
import { useOutletContext } from 'react-router'
import { getProfile } from '../queries/get-profile.ts'
import { ConnectionsSection } from './ConnectionsSection.tsx'
import { DisplayNameForm } from './DisplayNameForm.tsx'
import { LlmAccessSection } from './LlmAccessSection.tsx'

export const ProfileView = ({ llmAccessActions, children }: { llmAccessActions?: ReactNode; children?: ReactNode }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const displayName = useQuery(getProfile(workspaceId, memberId))
  if (!displayName) return null
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <h1 className="text-2xl font-semibold">Profile</h1>
      <DisplayNameForm workspaceId={workspaceId} currentName={displayName} />
      <LlmAccessSection workspaceId={workspaceId} memberId={memberId} actions={llmAccessActions} />
      <ConnectionsSection workspaceId={workspaceId} memberId={memberId} />
      {children}
    </div>
  )
}
