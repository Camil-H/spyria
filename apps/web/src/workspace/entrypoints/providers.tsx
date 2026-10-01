import { createContext, type ReactNode, use } from 'react'
import type { IdGenerator } from '../contracts/id-generator.ts'
import type { Transactor } from '../contracts/transactor.ts'

export type WorkspaceDependencies = { transactor: Transactor; idGenerator: IdGenerator; defaultRuntimeModel: string }

const WorkspaceDependenciesContext = createContext<WorkspaceDependencies | null>(null)

export const WorkspaceProvider = ({
  dependencies,
  children,
}: {
  dependencies: WorkspaceDependencies
  children: ReactNode
}) => <WorkspaceDependenciesContext value={dependencies}>{children}</WorkspaceDependenciesContext>

export const useWorkspaceDependencies = () => {
  const dependencies = use(WorkspaceDependenciesContext)
  if (!dependencies) throw new Error('WorkspaceProvider is missing')
  return dependencies
}
