import { isSetupCommands, type MemberId, requireWorkspacePermission, type SetupCommand } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { InvalidSetupCommands } from '../domain/errors.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { actorId: MemberId; commands: readonly SetupCommand[] }

export const setSetupCommands = ({ transactor }: Dependencies, { actorId, commands }: Input) =>
  transactor.run(async ({ memberships, workspaces, workspaceEvents }) => {
    await requireWorkspacePermission(memberships, actorId, 'runtimes.manage')
    if (!isSetupCommands(commands)) throw new InvalidSetupCommands()
    await workspaces.setSetupCommands(commands)
    await workspaceEvents.record({ type: 'setup_commands.changed', actorId, payload: { commands } })
  })
