import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { cardClass } from '@spyria/ui'
import { getProfile } from '../queries/get-profile.ts'
import { ActiveSessionsSection } from './ActiveSessionsSection.tsx'
import { DisplayNameForm } from './DisplayNameForm.tsx'
import { ProfilePictureSection } from './ProfilePictureSection.tsx'

export const AccountSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const profile = useQuery(getProfile, workspaceId, memberId)
  if (!profile) return null
  return (
    <div className="flex flex-col gap-8">
      <div className={`${cardClass} p-4`}>
        <ProfilePictureSection
          workspaceId={workspaceId}
          name={profile.displayName}
          avatar={profile.avatar}
          beside={<DisplayNameForm workspaceId={workspaceId} currentName={profile.displayName} />}
        />
      </div>
      <ActiveSessionsSection workspaceId={workspaceId} />
    </div>
  )
}
