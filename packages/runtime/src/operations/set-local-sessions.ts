import type { WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { assertAdmin } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; role: 'admin' | 'member'; isOn: boolean }

export const setLocalSessions = ({ transactor }: Dependencies, { workspaceId, role, isOn }: Input) => {
  assertAdmin(role)
  return transactor.run(({ workspaces }) => workspaces.setLocalSessions(workspaceId, isOn))
}
