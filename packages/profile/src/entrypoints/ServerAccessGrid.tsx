import {
  accessLevels,
  type ConnectionTool,
  isAllowedAtLevel,
  ownValueOf,
  type ToolServerAccess,
  type WorkspaceId,
} from '@spyria/kernel'
import { ErrorMessage, overlineClass, useGuardedAction } from '@spyria/ui'
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import type { ServerAccessList } from '../queries/list-workspace-connections.ts'
import { useProfileCommands } from './providers.tsx'
import { type TableTool, ToolTable } from './ToolTable.tsx'

type Target = { workspaceId: WorkspaceId; connectionId: string }
type Role = ServerAccessList['roles'][number]

const levelOf = (access: ToolServerAccess | undefined) => access?.level ?? accessLevels.none

const isAllowedFor = (role: Role, tool: ConnectionTool) =>
  ownValueOf(role.access?.toolChanges ?? {}, tool.name) ?? isAllowedAtLevel(levelOf(role.access), tool)

export const AllToolsCheckbox = ({
  label,
  allowedCount,
  toolCount,
  disabled,
  onChange,
}: {
  label: string
  allowedCount: number
  toolCount: number
  disabled: boolean
  onChange?: (isAllowed: boolean) => void
}) => {
  const checkboxRef = useRef<HTMLInputElement>(null)
  const isPartlyAllowed = allowedCount > 0 && allowedCount < toolCount
  useLayoutEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = isPartlyAllowed
  })
  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      aria-label={label}
      title={label}
      disabled={disabled || toolCount === 0}
      checked={toolCount > 0 && allowedCount === toolCount}
      onChange={() => onChange?.(allowedCount < toolCount)}
    />
  )
}

export const RoleHeading = ({ name, children }: { name: string; children: ReactNode }) => (
  <span className="flex flex-col items-center gap-1">
    {name}
    {children}
  </span>
)

export const ServerAccessGrid = ({ target, connection }: { target: Target; connection: ServerAccessList }) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const setAllowed = (role: Role, tools: readonly ConnectionTool[], isAllowed: boolean) =>
    run(() =>
      commands.setConnectionAccess({
        ...target,
        roleId: role.id,
        level: levelOf(role.access),
        toolChanges: Object.fromEntries(tools.map((tool) => [tool.name, isAllowed])),
      }),
    )
  return (
    <section aria-label={`Access to ${connection.name}`} className="flex flex-col gap-3">
      <h4 className={overlineClass}>Access by role</h4>
      <ToolTable<TableTool>
        serverName={connection.name}
        tools={connection.tools}
        columns={connection.roles.map((role) => ({
          key: role.id,
          heading: (shownTools, kind) => (
            <RoleHeading name={role.name}>
              <AllToolsCheckbox
                label={`All ${kind.toLowerCase()} tools shown for ${role.name}`}
                allowedCount={shownTools.filter((tool) => isAllowedFor(role, tool)).length}
                toolCount={shownTools.length}
                disabled={isPending}
                onChange={(isAllowed) => setAllowed(role, shownTools, isAllowed)}
              />
            </RoleHeading>
          ),
          cell: (tool) => (
            <input
              type="checkbox"
              aria-label={`${tool.name} for ${role.name}`}
              disabled={isPending}
              checked={isAllowedFor(role, tool)}
              onChange={() => setAllowed(role, [tool], !isAllowedFor(role, tool))}
            />
          ),
        }))}
      />
      <ErrorMessage message={errorMessage} />
    </section>
  )
}
