import {
  type DevLoopSettings,
  isDevLoopSettings,
  type MemberId,
  requirePermissionIn,
  type WorkspacePermission,
} from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { InvalidDevLoopSettings } from '../domain/errors.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { memberId: MemberId; permissions: readonly WorkspacePermission[]; settings: DevLoopSettings | null }

export const setDevLoop = ({ transactor }: Dependencies, { memberId, permissions, settings }: Input) => {
  requirePermissionIn(permissions, 'github.manage')
  if (settings !== null && !isDevLoopSettings(settings)) throw new InvalidDevLoopSettings()
  return transactor.run(async ({ devLoop }) => {
    await devLoop.setSettings(settings)
    await devLoop.recordChange(memberId, settings)
  })
}
