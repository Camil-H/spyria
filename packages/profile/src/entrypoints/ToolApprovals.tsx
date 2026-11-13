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

const toolGroups = [
  {
    title: 'Read',
    isInGroup: (tool: ConnectionTool) => tool.readOnly && !tool.destructive,
    note: 'By default, read tools run without waiting for your approval.',
  },
  {
    title: 'Write',
    isInGroup: (tool: ConnectionTool) => !tool.readOnly && !tool.destructive,
    note: 'Write tools follow this choice, unless you choose otherwise for one below.',
  },
  {
    title: 'Destructive',
    isInGroup: (tool: ConnectionTool) => tool.destructive,
    note: 'By default, tools the server marks destructive wait for your approval.',
  },
] as const

type GroupTitle = (typeof toolGroups)[number]['title']

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
  const choices = approvalChoicesOf(server)
  const ownApprovalOf = (tool: ConnectionTool) => ownValueOf(server.approvals?.toolApprovals, tool.name) ?? null
  const defaultApprovalOf = (tool: ConnectionTool) => defaultToolApprovalOf(server, tool, server.approvals)
  const groups = toolGroups
    .map((group) => ({ ...group, tools: server.tools.filter(group.isInGroup) }))
    .filter(({ tools }) => tools.length > 0)
  const [openGroup, setOpenGroup] = useState<GroupTitle | undefined>(
    () => (groups.find(({ title }) => title === 'Write') ?? groups[0])?.title,
  )
  const setApproval = (tool: string | null, approval: ToolApproval | null) =>
    commands.setToolApproval({ workspaceId, connectionId: server.id, tool, approval })
  const chooseForTool = (tool: ConnectionTool, choice: string) =>
    run(() => setApproval(tool.name, choice === defaultChoice ? null : (choice as ToolApproval)))
  const chooseForWriteTools = (choice: ToolApproval) =>
    run(() => setApproval(null, choice === serverApprovalOf(server) ? null : choice))
  const chooseForAll = (tools: readonly ConnectionTool[], choice: ToolApproval) =>
    run(async () => {
      const changes = tools
        .map((tool) => ({ tool, approval: choice === defaultApprovalOf(tool) ? null : choice }))
        .filter(({ tool, approval }) => approval !== ownApprovalOf(tool))
      await Promise.all(changes.map(({ tool, approval }) => setApproval(tool.name, approval)))
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
      <Root
        value={openGroup}
        onValueChange={(value) => setOpenGroup(value as GroupTitle)}
        className="flex flex-col gap-3"
      >
        <List aria-label="Tool kinds" className="flex gap-2 border-b border-line">
          {groups.map(({ title, tools }) => (
            <Trigger key={title} value={title} className={`${tabTriggerClass} px-3`}>
              {title} <span className="text-xs text-muted">{tools.length}</span>
            </Trigger>
          ))}
        </List>
        {groups.map(({ title, tools, note }) => {
          const shownTools = tools.filter(isShown)
          return (
            <Content key={title} value={title} className="flex flex-col gap-3">
              <p className="text-sm text-muted">{note}</p>
              {title === 'Write' ? (
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
                      aria-label={`Set all ${title.toLowerCase()} tools to ${approvalLabels[choice]}`}
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
                  aria-label={`Search ${title.toLowerCase()} tools`}
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
                <ul aria-label={`${title} tools`} className={rowListClass}>
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
