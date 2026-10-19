import { requirePermissionIn, type WorkspaceId, type WorkspacePermission } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; permissions: readonly WorkspacePermission[]; isOn: boolean }

export const setLocalSessions = ({ transactor }: Dependencies, { workspaceId, permissions, isOn }: Input) => {
  requirePermissionIn(permissions, 'runtimes.manage')
  return transactor.run(({ workspaces }) => workspaces.setLocalSessions(workspaceId, isOn))
}
