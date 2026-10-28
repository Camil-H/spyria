import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { getOnboarding } from '../queries/get-onboarding.ts'

export const useOnboarding = (workspaceId: WorkspaceId, usesSingleSignOn: boolean) => {
  const { memberId } = useSession()
  return useQuery(getOnboarding, workspaceId, memberId, usesSingleSignOn)
}
