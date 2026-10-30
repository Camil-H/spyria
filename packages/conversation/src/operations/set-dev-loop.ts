import { type DevLoopSettings, isDevLoopSettings, requirePermissionIn, type WorkspacePermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { InvalidDevLoopSettings } from '../domain/errors.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { permissions: readonly WorkspacePermission[]; settings: DevLoopSettings | null }

export const setDevLoop = ({ transactor }: Dependencies, { permissions, settings }: Input) => {
  requirePermissionIn(permissions, 'github.manage')
  if (settings !== null && !isDevLoopSettings(settings)) throw new InvalidDevLoopSettings()
  return transactor.run(({ devLoop }) => devLoop.setSettings(settings))
}
