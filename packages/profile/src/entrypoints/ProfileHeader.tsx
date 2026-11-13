import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { MemberAvatar } from '@spyria/ui'
import { getProfile } from '../queries/get-profile.ts'

export const ProfileHeader = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const profile = useQuery(getProfile, workspaceId, memberId)
  if (!profile) return null
  return (
    <div className="flex items-center gap-4">
      <MemberAvatar name={profile.displayName} image={profile.avatar} size={56} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-lg font-semibold">{profile.displayName}</span>
        <span className="truncate text-sm text-muted">{profile.email}</span>
      </div>
    </div>
  )
}
