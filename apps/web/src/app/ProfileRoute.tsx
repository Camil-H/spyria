import type { WorkspaceId } from '@spyria/kernel'
import { ChecklistBlock } from '@spyria/onboarding'
import { ProfileView } from '@spyria/profile'
import { MyMachineSection } from '@spyria/runtime'
import { useSession } from '@spyria/session'
import { MyUsageSection } from '@spyria/usage'
import { useOutletContext } from 'react-router'

const ProfileRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  return (
    <div className="px-6 py-6 md:px-12 xl:px-16">
      <ProfileView intro={<ChecklistBlock workspaceId={workspaceId} scope="member" />}>
        <MyMachineSection workspaceId={workspaceId} memberId={memberId} />
        <MyUsageSection workspaceId={workspaceId} memberId={memberId} />
      </ProfileView>
    </div>
  )
}

export default ProfileRoute
