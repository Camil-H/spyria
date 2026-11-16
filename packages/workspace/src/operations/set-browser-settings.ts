import { type BrowserSettings, isBrowserSettings, type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { InvalidBrowserSettings } from '../domain/errors.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { actorId: MemberId; settings: BrowserSettings }

export const setBrowserSettings = ({ transactor }: Dependencies, { actorId, settings }: Input) =>
  transactor.run(async ({ memberships, workspaces, workspaceEvents }) => {
    await requireWorkspacePermission(memberships, actorId, 'tools.manage')
    if (!isBrowserSettings(settings)) throw new InvalidBrowserSettings()
    await workspaces.setBrowserSettings(settings)
    await workspaceEvents.record({ type: 'browser.changed', actorId, payload: { settings } })
  })
