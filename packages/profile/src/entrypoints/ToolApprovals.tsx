import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import {
  approvalChoicesOf,
  type ConnectionTool,
  defaultToolApprovalOf,
  ownValueOf,
  serverApprovalOf,
  type ToolApproval,
  type ToolApprovalPreference,
  type WorkspaceId,
} from '@spyria/kernel'
import {
  Dialog,
  ErrorMessage,
  fieldClass,
  rowClass,
  rowListClass,
  SegmentedChoice,
  smallGhostButtonClass,
  tabTriggerClass,
  useGuardedAction,
} from '@spyria/ui'
import { useState } from 'react'
import { approvalChangesOf, type ToolKind, toolKindOf, toolKinds } from '../domain/tool-approval.ts'
import { type ConnectionSignIn, connectionSignIns } from '../domain/workspace-connection.ts'
import { useProfileCommands } from './providers.tsx'

type ApprovalServer = {
  id: string
  name: string
  signIn: ConnectionSignIn
  tools: readonly ConnectionTool[]
  approvals: ToolApprovalPreference | undefined
}

const approvalLabels: Record<ToolApproval, string> = {
  never: 'Never',
  always: 'Always',
  guest: "On a guest's prompt",
}
const defaultChoice = 'default'

const kindNotes: Record<ToolKind, string> = {
  Read: 'By default, read tools run without waiting for your approval.',
  Write: 'Write tools follow this choice, unless you choose otherwise for one below.',
  Destructive: 'By default, tools the server marks destructive wait for your approval.',
}

export const ToolApprovals = ({
  workspaceId,
  server,
  onClose,
}: {
  workspaceId: WorkspaceId
  server: ApprovalServer
  onClose: () => void
}) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [search, setSearch] = useState('')
  const [isOnlyChanged, setIsOnlyChanged] = useState(false)
  const [chosenKind, setChosenKind] = useState<ToolKind>('Write')
  const choices = approvalChoicesOf(server)
  const ownApprovalOf = (tool: ConnectionTool) => ownValueOf(server.approvals?.toolApprovals, tool.name) ?? null
  const defaultApprovalOf = (tool: ConnectionTool) => defaultToolApprovalOf(server, tool, server.approvals)
  const groups = toolKinds
    .map((kind) => ({ kind, tools: server.tools.filter((tool) => toolKindOf(tool) === kind) }))
    .filter(({ tools }) => tools.length > 0)
  const openKind = groups.some(({ kind }) => kind === chosenKind) ? chosenKind : groups[0]?.kind
  const setApproval = (tool: string | null, approval: ToolApproval | null) =>
    commands.setToolApproval({ workspaceId, connectionId: server.id, tool, approval })
  const chooseForTool = (tool: ConnectionTool, choice: string) =>
    run(() => setApproval(tool.name, choice === defaultChoice ? null : (choice as ToolApproval)))
  const chooseForWriteTools = (choice: ToolApproval) =>
    run(() => setApproval(null, choice === serverApprovalOf(server) ? null : choice))
  const chooseForAll = (tools: readonly ConnectionTool[], choice: ToolApproval) =>
    run(async () => {
      const changes = approvalChangesOf(tools, choice, { ownApprovalOf, defaultApprovalOf })
      await Promise.all(changes.map(({ tool, approval }) => setApproval(tool, approval)))
    })
  const searched = search.trim().toLowerCase()
  const isShown = (tool: ConnectionTool) =>
    tool.name.toLowerCase().includes(searched) && (!isOnlyChanged || ownApprovalOf(tool) !== null)
  return (
    <Dialog label={`Approvals for ${server.name}`} closeLabel="Done" isWide onClose={onClose}>
      <p className="text-sm text-muted">
        {server.signIn === connectionSignIns.member
          ? 'Choose which calls wait for your approval before they run with your account, on your prompts in any chat.'
          : 'Choose which calls wait for your approval before they run in the chats you own, whoever prompts.'}
      </p>
      {groups.length === 0 && <p className="text-sm text-muted">You may use none of its tools</p>}
      <Root
        value={openKind}
        onValueChange={(value) => setChosenKind(value as ToolKind)}
        className="flex flex-col gap-3"
      >
        <List aria-label="Tool kinds" className="flex gap-2 border-b border-line">
          {groups.map(({ kind, tools }) => (
            <Trigger key={kind} value={kind} className={`${tabTriggerClass} px-3`}>
              {kind} <span className="text-xs text-muted">{tools.length}</span>
            </Trigger>
          ))}
        </List>
        {groups.map(({ kind, tools }) => {
          const shownTools = tools.filter(isShown)
          return (
            <Content key={kind} value={kind} className="flex flex-col gap-3">
              <p className="text-sm text-muted">{kindNotes[kind]}</p>
              {kind === 'Write' ? (
                <SegmentedChoice
                  label={`Write tools of ${server.name}`}
                  name={`write-approval-${server.id}`}
                  options={choices}
                  labels={approvalLabels}
                  value={server.approvals?.serverApproval ?? serverApprovalOf(server)}
                  onChange={chooseForWriteTools}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  Set all to
                  {choices.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      aria-label={`Set all ${kind.toLowerCase()} tools to ${approvalLabels[choice]}`}
                      disabled={isPending}
                      className={smallGhostButtonClass}
                      onClick={() => chooseForAll(tools, choice)}
                    >
                      {approvalLabels[choice]}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="search"
                  aria-label={`Search ${kind.toLowerCase()} tools`}
                  placeholder="Search tools"
                  className={`${fieldClass} min-w-0 flex-1`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={isOnlyChanged}
                    onChange={(event) => setIsOnlyChanged(event.target.checked)}
                  />
                  Only my changes
                </label>
              </div>
              {shownTools.length === 0 ? (
                <p className="text-sm text-muted">No tool matches</p>
              ) : (
                <ul aria-label={`${kind} tools`} className={rowListClass}>
                  {shownTools.map((tool) => {
                    const ownApproval = ownApprovalOf(tool)
                    return (
                      <li key={tool.name} className={`${rowClass} py-2`}>
                        <span className={`min-w-0 flex-1 truncate ${ownApproval ? 'font-medium' : ''}`}>
                          {tool.name}
                        </span>
                        <select
                          aria-label={`Approval for ${tool.name}`}
                          className={fieldClass}
                          disabled={isPending}
                          value={ownApproval ?? defaultChoice}
                          onChange={(event) => chooseForTool(tool, event.target.value)}
                        >
                          <option value={defaultChoice}>Default ({approvalLabels[defaultApprovalOf(tool)]})</option>
                          {choices.map((choice) => (
                            <option key={choice} value={choice}>
                              {approvalLabels[choice]}
                            </option>
                          ))}
                        </select>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Content>
          )
        })}
      </Root>
      <ErrorMessage message={errorMessage} />
    </Dialog>
  )
}
