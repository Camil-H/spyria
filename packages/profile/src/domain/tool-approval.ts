import { approvalChoicesOf, type ToolApproval, type ToolApprovalPreference } from '@spyria/kernel'
import { InvalidConnection } from './errors.ts'
import type { WorkspaceConnection } from './workspace-connection.ts'

export type ApprovalChange = { tool: string | null; approval: ToolApproval | null }

export const preferenceWith = (
  connection: WorkspaceConnection,
  preference: ToolApprovalPreference | undefined,
  { tool, approval }: ApprovalChange,
): ToolApprovalPreference => {
  if (approval !== null && !approvalChoicesOf(connection).includes(approval))
    throw new InvalidConnection(`${connection.name} takes no such approval`)
  if (tool !== null && !connection.tools.some(({ name }) => name === tool))
    throw new InvalidConnection(`${connection.name} has no tool ${tool}`)
  const current = preference ?? { connectionId: connection.id, serverApproval: null, toolApprovals: {} }
  if (tool === null) return { ...current, serverApproval: approval }
  const { [tool]: _replaced, ...otherTools } = current.toolApprovals
  return { ...current, toolApprovals: approval === null ? otherTools : { ...otherTools, [tool]: approval } }
}
