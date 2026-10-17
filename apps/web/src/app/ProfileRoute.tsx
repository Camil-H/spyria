import type { WorkspaceId } from '@hq/kernel'
import { ProfileView } from '@hq/profile'
import { MyMachineSection } from '@hq/runtime'
import { useSession } from '@hq/session'
import { useOutletContext } from 'react-router'

const ProfileRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  return (
    <div className="p-6">
      <ProfileView>
        <MyMachineSection workspaceId={workspaceId} memberId={memberId} />
      </ProfileView>
    </div>
  )
}

export default ProfileRoute
