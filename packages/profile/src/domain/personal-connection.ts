import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ToolNotInCatalog } from './errors.ts'

export const connectionStatuses = { connected: 'Connected', needsReconnection: 'Needs reconnection' } as const
export type ConnectionStatus = (typeof connectionStatuses)[keyof typeof connectionStatuses]
export const notConnectedStatus = 'Not connected'

export type PersonalConnection = Readonly<{
  workspaceId: WorkspaceId
  memberId: MemberId
  tool: string
  status: ConnectionStatus
}>

export const connectedTool = (
  owner: Pick<PersonalConnection, 'workspaceId' | 'memberId'>,
  tool: string,
  catalog: readonly string[],
  status: ConnectionStatus = connectionStatuses.connected,
): PersonalConnection => {
  if (!catalog.includes(tool)) throw new ToolNotInCatalog(tool)
  return { ...owner, tool, status }
}

export const connectionStatusOf = (sessionStatuses: readonly string[]) =>
  sessionStatuses.includes('active')
    ? connectionStatuses.connected
    : sessionStatuses.includes('needs_reauth')
      ? connectionStatuses.needsReconnection
      : undefined
