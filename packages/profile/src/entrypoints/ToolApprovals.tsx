import {
  approvalChoicesOf,
  type ConnectionTool,
  defaultToolApprovalOf,
  serverApprovalOf,
  type ToolApproval,
  type ToolApprovalPreference,
  type WorkspaceId,
} from '@spyria/kernel'
import { ErrorMessage, fieldClass, labelClass, useGuardedAction } from '@spyria/ui'
import type { ConnectionSignIn } from '../domain/workspace-connection.ts'
import { useProfileCommands } from './providers.tsx'
import { ToolList } from './ToolList.tsx'

const approvalLabels: Record<ToolApproval, string> = {
  never: 'Never',
  always: 'Always',
  guest: "On a guest's prompt",
}
const defaultChoice = 'default'

export const ToolApprovals = ({
  workspaceId,
  server,
}: {
  workspaceId: WorkspaceId
  server: {
    id: string
    name: string
    signIn: ConnectionSignIn
    tools: readonly ConnectionTool[]
    approvals: ToolApprovalPreference | undefined
  }
}) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const choices = approvalChoicesOf(server)
  const choose = (tool: string | null, choice: string) =>
    run(() =>
      commands.setToolApproval({
        workspaceId,
        connectionId: server.id,
        tool,
        approval: choice === defaultChoice ? null : (choice as ToolApproval),
      }),
    )
  const approvalSelect = (label: string, tool: string | null, chosen: ToolApproval | null, fallback: ToolApproval) => (
    <select
      aria-label={label}
      className={fieldClass}
      disabled={isPending}
      value={chosen ?? defaultChoice}
      onChange={(event) => choose(tool, event.target.value)}
    >
      <option value={defaultChoice}>Default ({approvalLabels[fallback]})</option>
      {choices.map((choice) => (
        <option key={choice} value={choice}>
          {approvalLabels[choice]}
        </option>
      ))}
    </select>
  )
  return (
    <section
      aria-label={`Approvals for ${server.name}`}
      className="flex flex-col gap-3 rounded-md border border-line p-2"
    >
      <p className="text-muted">
        Choose which calls wait for your approval before they run on your chats. Read tools default to Never, and tools
        the server marks destructive to Always.
      </p>
      <label className={`${labelClass} w-fit`}>
        Write tools of {server.name}
        {approvalSelect(
          `Approval for ${server.name}`,
          null,
          server.approvals?.serverApproval ?? null,
          serverApprovalOf({ signIn: server.signIn }),
        )}
      </label>
      <ToolList
        label={`${server.name} approvals`}
        tools={server.tools}
        controlOf={(tool) =>
          approvalSelect(
            `Approval for ${tool.name}`,
            tool.name,
            server.approvals?.toolApprovals[tool.name] ?? null,
            defaultToolApprovalOf(server, tool, server.approvals),
          )
        }
      />
      <ErrorMessage message={errorMessage} />
    </section>
  )
}
