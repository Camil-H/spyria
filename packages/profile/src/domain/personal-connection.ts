import type { MemberId, WorkspaceId } from '@hq/kernel'
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
): PersonalConnection => {
  if (!catalog.includes(tool)) throw new ToolNotInCatalog(tool)
  return { ...owner, tool, status: 'Connected' }
}
