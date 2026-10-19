import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ToolNotInCatalog } from './errors.ts'

export type PersonalConnection = Readonly<{
  workspaceId: WorkspaceId
  memberId: MemberId
  tool: string
  status: string
}>

export const connectedTool = (
  owner: Pick<PersonalConnection, 'workspaceId' | 'memberId'>,
  tool: string,
  catalog: readonly string[],
  status = 'Connected',
): PersonalConnection => {
  if (!catalog.includes(tool)) throw new ToolNotInCatalog(tool)
  return { ...owner, tool, status }
}

export const connectionStatusOf = (sessionStatuses: readonly string[]) =>
  sessionStatuses.includes('active')
    ? 'Connected'
    : sessionStatuses.includes('needs_reauth')
      ? 'Needs reconnection'
      : undefined
