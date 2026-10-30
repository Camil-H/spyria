import { type DevLoopSettings, isDevLoopSettings, type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { InvalidDevLoopSettings } from '../domain/errors.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { actorId: MemberId; settings: DevLoopSettings | null }

export const setDevLoop = ({ transactor }: Dependencies, { actorId, settings }: Input) =>
  transactor.run(async ({ memberships, workspaces, workspaceEvents }) => {
    await requireWorkspacePermission(memberships, actorId, 'github.manage')
    if (settings !== null && !isDevLoopSettings(settings)) throw new InvalidDevLoopSettings()
    await workspaces.setDevLoop(settings)
    await workspaceEvents.record({ type: 'dev_loop.changed', actorId, payload: { settings } })
  })
