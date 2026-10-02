import type { IdGenerator } from '@hq/kernel'
import { createContext, type ReactNode, use } from 'react'
import type { PlanLoginProbe } from '../contracts/plan-login-probe.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'

export type ProfileDependencies = {
  transactor: ProfileTransactor
  idGenerator: IdGenerator
  planLoginProbe: PlanLoginProbe
}

const ProfileDependenciesContext = createContext<ProfileDependencies | null>(null)

export const ProfileProvider = ({
  dependencies,
  children,
}: {
  dependencies: ProfileDependencies
  children: ReactNode
}) => <ProfileDependenciesContext value={dependencies}>{children}</ProfileDependenciesContext>

export const useProfileDependencies = () => {
  const dependencies = use(ProfileDependenciesContext)
  if (!dependencies) throw new Error('ProfileProvider is missing')
  return dependencies
}
