import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import {
  type AccessLevel,
  accessLevels,
  type ConnectionTool,
  isAllowedAtLevel,
  type MemberId,
  ownValueOf,
  type ToolServerAccess,
  type WorkspaceId,
} from '@spyria/kernel'
import {
  cardClass,
  ErrorMessage,
  fieldClass,
  labelClass,
  smallGhostButtonClass,
  tabTriggerClass,
  useGuardedAction,
} from '@spyria/ui'
import { useState } from 'react'
import { type ToolKind, toolKindOf, toolKinds } from '../domain/tool-approval.ts'
import type { AccessSubject } from '../domain/workspace-connection.ts'
import type { ServerAccessList } from '../queries/list-workspace-connections.ts'
import { useProfileCommands } from './providers.tsx'

type Target = { workspaceId: WorkspaceId; connectionId: string }
type AccessHolder = { key: string; name: string; subject: AccessSubject; access: ToolServerAccess | undefined }
type ListedTool = ConnectionTool & { summary?: string }

const levelLabels: Record<AccessLevel, string> = { none: 'None', read: 'Read', write: 'Read and write' }

const levelOf = (holder: AccessHolder) => holder.access?.level ?? accessLevels.none

const isAllowedFor = (holder: AccessHolder, tool: ConnectionTool) =>
  ownValueOf(holder.access?.toolChanges ?? {}, tool.name) ?? isAllowedAtLevel(levelOf(holder), tool)

const holdersOf = (connection: ServerAccessList): AccessHolder[] => [
  ...connection.roles.map((role) => ({
    key: `role-${role.id}`,
    name: role.name,
    subject: { roleId: role.id },
    access: role.access,
  })),
  ...connection.namedMembers.map((member) => ({
    key: `member-${member.id}`,
    name: member.name,
    subject: { memberId: member.id },
    access: member.access,
  })),
]

export const ServerAccessGrid = ({ target, connection }: { target: Target; connection: ServerAccessList }) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [chosenKind, setChosenKind] = useState<ToolKind>('Read')
  const [search, setSearch] = useState('')
  const holders = holdersOf(connection)
  const namedMemberKeys = new Set(connection.namedMembers.map((member) => `member-${member.id}`))
  const groups = toolKinds
    .map((kind) => ({ kind, tools: connection.tools.filter((tool) => toolKindOf(tool) === kind) as ListedTool[] }))
    .filter(({ tools }) => tools.length > 0)
  const openKind = groups.some(({ kind }) => kind === chosenKind) ? chosenKind : groups[0]?.kind
  const save = (holder: AccessHolder, changed: { level: AccessLevel | null; toolChanges?: Record<string, boolean> }) =>
    run(() => commands.setConnectionAccess({ ...target, ...holder.subject, toolChanges: {}, ...changed }))
  const toggle = (holder: AccessHolder, tool: ConnectionTool) =>
    save(holder, { level: levelOf(holder), toolChanges: { [tool.name]: !isAllowedFor(holder, tool) } })
  const addMember = (memberId: MemberId) =>
    run(() => commands.setConnectionAccess({ ...target, memberId, level: accessLevels.none, toolChanges: {} }))
  const searched = search.trim().toLowerCase()
  return (
    <section aria-label={`Access to ${connection.name}`} className="flex flex-col gap-3">
      <h4 className="text-xs font-semibold uppercase text-muted">Access</h4>
      <Root
        value={openKind}
        onValueChange={(value) => setChosenKind(value as ToolKind)}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line">
          <List aria-label={`Tool kinds of ${connection.name}`} className="flex gap-2">
            {groups.map(({ kind, tools }) => (
              <Trigger key={kind} value={kind} className={`${tabTriggerClass} px-3`}>
                {kind} <span className="text-xs text-muted">{tools.length}</span>
              </Trigger>
            ))}
          </List>
          <input
            type="search"
            aria-label={`Search tools of ${connection.name}`}
            placeholder="Search tools"
            className={`${fieldClass} mb-1.5 w-48`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {groups.map(({ kind, tools }) => {
          const shownTools = tools.filter((tool) => tool.name.toLowerCase().includes(searched))
          return (
            <Content key={kind} value={kind} className={`${cardClass} overflow-x-auto`}>
              <table aria-label={`${kind} tools of ${connection.name}`} className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-muted">
                      Tool
                    </th>
                    {holders.map((holder) => (
                      <th key={holder.key} scope="col" className="min-w-32 px-3 py-2 text-center font-medium">
                        <span className="flex flex-col items-center gap-1">
                          {holder.name}
                          <select
                            aria-label={`Access of ${holder.name}`}
                            className={`${fieldClass} text-xs font-normal`}
                            disabled={isPending}
                            value={levelOf(holder)}
                            onChange={(event) => save(holder, { level: event.target.value as AccessLevel })}
                          >
                            {Object.values(accessLevels).map((option) => (
                              <option key={option} value={option}>
                                {levelLabels[option]}
                              </option>
                            ))}
                          </select>
                          {namedMemberKeys.has(holder.key) && (
                            <button
                              type="button"
                              className={`${smallGhostButtonClass} font-normal`}
                              disabled={isPending}
                              onClick={() => save(holder, { level: null })}
                            >
                              Remove {holder.name}
                            </button>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shownTools.length === 0 && (
                    <tr>
                      <td colSpan={holders.length + 1} className="px-4 py-3 text-muted">
                        No tool matches
                      </td>
                    </tr>
                  )}
                  {shownTools.map((tool) => (
                    <tr key={tool.name} className="hover:bg-hover">
                      <th scope="row" className="px-4 py-2 text-left font-normal">
                        <span className="flex flex-col">
                          <span className="font-mono text-xs">{tool.name}</span>
                          {tool.summary && <span className="text-xs text-muted">{tool.summary}</span>}
                        </span>
                      </th>
                      {holders.map((holder) => (
                        <td key={holder.key} className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            aria-label={`${tool.name} for ${holder.name}`}
                            disabled={isPending}
                            checked={isAllowedFor(holder, tool)}
                            onChange={() => toggle(holder, tool)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Content>
          )
        })}
      </Root>
      {connection.otherMembers.length > 0 && (
        <label className={`${labelClass} w-fit`}>
          A member's own access replaces their role's
          <select
            className={fieldClass}
            disabled={isPending}
            value=""
            onChange={(event) => addMember(event.target.value as MemberId)}
          >
            <option value="">Add a member</option>
            {connection.otherMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorMessage message={errorMessage} />
    </section>
  )
}
