import type { WorkspaceId } from '@spyria/kernel'
import { ProfileView } from '@spyria/profile'
import { MyMachineSection } from '@spyria/runtime'
import { useSession } from '@spyria/session'
import { MyUsageSection } from '@spyria/usage'
import { useOutletContext } from 'react-router'

const ProfileRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  return (
    <div className="p-6">
      <ProfileView>
        <MyMachineSection workspaceId={workspaceId} memberId={memberId} />
        <MyUsageSection workspaceId={workspaceId} memberId={memberId} />
      </ProfileView>
    </div>
  )
}

export default ProfileRoute
