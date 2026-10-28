import type { WorkspaceId } from '@spyria/kernel'
import { ChecklistBlock } from '@spyria/onboarding'
import { ProfileView } from '@spyria/profile'
import { MyMachineSection } from '@spyria/runtime'
import { useSession } from '@spyria/session'
import { MyUsageSection } from '@spyria/usage'
import { use } from 'react'
import { useOutletContext } from 'react-router'
import { sharedAuthMode } from './auth.ts'

const ProfileRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const usesSingleSignOn = use(sharedAuthMode()).authMode === 'sso'
  return (
    <div className="p-6">
      <ProfileView
        intro={<ChecklistBlock workspaceId={workspaceId} scope="member" usesSingleSignOn={usesSingleSignOn} />}
      >
        <MyMachineSection workspaceId={workspaceId} memberId={memberId} />
        <MyUsageSection workspaceId={workspaceId} memberId={memberId} />
      </ProfileView>
    </div>
  )
}

export default ProfileRoute
