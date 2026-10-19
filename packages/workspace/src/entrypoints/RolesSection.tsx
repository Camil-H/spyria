import type { Snapshot } from '@hq/db'
import { useQuery } from '@hq/db/react'
import {
  type ChatPermission,
  chatPermissions,
  type WorkspaceId,
  type WorkspacePermission,
  workspacePermissionLabels,
  workspacePermissions,
} from '@hq/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  tabTriggerClass,
  useGuardedAction,
} from '@hq/ui'
import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import { type SubmitEvent, useState } from 'react'
import { listChatRoles, listWorkspaceRoles } from '../queries/list-roles.ts'
import type { WorkspaceCommands } from './commands.ts'
import { useWorkspaceCommands } from './providers.tsx'

type StoredRole<Permission extends string> = {
  id: string
  name: string
  permissions: readonly Permission[]
  builtIn: boolean
}
type RoleInput<Permission extends string> = { name: string; permissions: readonly Permission[] }
type RoleTarget = { workspaceId: WorkspaceId; roleId: string }
type RoleKind<Permission extends string> = {
  title: string
  description: string
  deletionHint: string
  permissions: readonly Permission[]
  labels: Record<Permission, string>
  lockedPermissions: readonly Permission[]
  listRoles: (workspaceId: WorkspaceId) => (snapshot: Snapshot) => readonly StoredRole<Permission>[]
  commandsOf: (commands: WorkspaceCommands) => {
    create: (input: RoleInput<Permission> & { workspaceId: WorkspaceId }) => Promise<string>
    update: (input: RoleInput<Permission> & RoleTarget) => Promise<string>
    remove: (target: RoleTarget) => Promise<string>
  }
}

const workspaceRoleKind: RoleKind<WorkspacePermission> = {
  title: 'Workspace roles',
  description:
    'Each member holds one of these roles in the workspace. Built-in roles are fixed; custom roles can be changed.',
  deletionHint: 'A role still held by a member or a pending invite cannot be deleted.',
  permissions: workspacePermissions,
  labels: workspacePermissionLabels,
  lockedPermissions: [],
  listRoles: listWorkspaceRoles,
  commandsOf: (commands) => ({
    create: commands.createWorkspaceRole,
    update: commands.updateWorkspaceRole,
    remove: commands.deleteWorkspaceRole,
  }),
}

const chatRoleKind: RoleKind<ChatPermission> = {
  title: 'Chat roles',
  description: 'Each chat gives its people one of these roles. Built-in roles are fixed; custom roles can be changed.',
  deletionHint: 'A role still held in a chat cannot be deleted.',
  permissions: chatPermissions,
  labels: {
    'chat.read': 'Read the chat',
    'chat.post': 'Post and prompt the agent',
    'session.configure': 'Choose the model and stop the agent',
    'tools.manage': "Manage the chat's tools",
    'members.invite': 'Invite people to the chat',
    'members.manage': 'Change roles and remove people',
    'chat.admin': 'Rename, move and archive the chat, change its visibility',
  },
  lockedPermissions: ['chat.read'],
  listRoles: listChatRoles,
  commandsOf: (commands) => ({
    create: commands.createChatRole,
    update: commands.updateChatRole,
    remove: commands.deleteChatRole,
  }),
}

const RoleForm = <Permission extends string>({
  kind,
  label,
  role,
  save,
  onClose,
}: {
  kind: RoleKind<Permission>
  label: string
  role?: StoredRole<Permission>
  save: (input: RoleInput<Permission>) => Promise<unknown>
  onClose: () => void
}) => {
  const [name, setName] = useState(role?.name ?? '')
  const [permissions, setPermissions] = useState<readonly Permission[]>(role?.permissions ?? kind.lockedPermissions)
  const { errorMessage, isPending, run } = useGuardedAction()
  const toggle = (permission: Permission) =>
    setPermissions(
      permissions.includes(permission)
        ? permissions.filter((granted) => granted !== permission)
        : [...permissions, permission],
    )
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await run(() => save({ name, permissions }))) onClose()
  }
  return (
    <form aria-label={label} onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <label className={labelClass}>
        Name
        <input className={fieldClass} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      </label>
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="mb-1 text-xs font-semibold uppercase text-muted">Permissions</legend>
        {kind.permissions.map((permission) => {
          const isLocked = kind.lockedPermissions.includes(permission)
          return (
            <label key={permission} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isLocked || permissions.includes(permission)}
                disabled={isLocked || isPending}
                onChange={() => toggle(permission)}
              />
              {kind.labels[permission]}
            </label>
          )
        })}
      </fieldset>
      <ErrorMessage message={errorMessage} />
      <div className="flex gap-2">
        <button type="submit" className={buttonClass} disabled={isPending || name.trim() === ''}>
          Save
        </button>
        <button type="button" className={ghostButtonClass} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

const CustomRoleActions = <Permission extends string>({
  kind,
  workspaceId,
  role,
}: {
  kind: RoleKind<Permission>
  workspaceId: WorkspaceId
  role: StoredRole<Permission>
}) => {
  const commands = kind.commandsOf(useWorkspaceCommands())
  const [isEditing, setIsEditing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const { errorMessage, isPending, run } = useGuardedAction()
  const target = { workspaceId, roleId: role.id }
  return (
    <>
      <span className="mt-2 flex gap-2">
        <button
          type="button"
          aria-label={`Edit ${role.name}`}
          className={ghostButtonClass}
          onClick={() => setIsEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          aria-label={`Delete ${role.name}`}
          className={ghostButtonClass}
          onClick={() => setIsDeleting(true)}
        >
          Delete
        </button>
      </span>
      {isEditing && (
        <div className="mt-3">
          <RoleForm
            kind={kind}
            label={`Edit ${role.name}`}
            role={role}
            save={(input) => commands.update({ ...target, ...input })}
            onClose={() => setIsEditing(false)}
          />
        </div>
      )}
      {isDeleting && (
        <Dialog label="Delete role" subject={role.name} onClose={() => setIsDeleting(false)}>
          <p className="text-sm text-muted">{kind.deletionHint}</p>
          <ErrorMessage message={errorMessage} />
          <button
            type="button"
            className={buttonClass}
            disabled={isPending}
            onClick={() => run(() => commands.remove(target))}
          >
            Delete
          </button>
        </Dialog>
      )}
    </>
  )
}

const RoleList = <Permission extends string>({
  kind,
  workspaceId,
}: {
  kind: RoleKind<Permission>
  workspaceId: WorkspaceId
}) => {
  const commands = kind.commandsOf(useWorkspaceCommands())
  const roles = useQuery(kind.listRoles(workspaceId))
  const [isCreating, setIsCreating] = useState(false)
  return (
    <LabelledSection title={kind.title}>
      <p className="text-sm text-muted">{kind.description}</p>
      <ul aria-label={kind.title} className="flex flex-col gap-3">
        {roles.map((role) => (
          <li key={role.id} aria-label={role.name} className="rounded-lg border border-line p-3">
            <h3 className="font-medium">{role.name}</h3>
            {role.permissions.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No permissions</p>
            ) : (
              <ul className="mt-1 list-disc pl-5 text-sm text-muted">
                {role.permissions.map((permission) => (
                  <li key={permission}>{kind.labels[permission]}</li>
                ))}
              </ul>
            )}
            {!role.builtIn && <CustomRoleActions kind={kind} workspaceId={workspaceId} role={role} />}
          </li>
        ))}
      </ul>
      {isCreating ? (
        <RoleForm
          kind={kind}
          label="New role"
          save={(input) => commands.create({ workspaceId, ...input })}
          onClose={() => setIsCreating(false)}
        />
      ) : (
        <button type="button" className={`self-start ${buttonClass}`} onClick={() => setIsCreating(true)}>
          New role
        </button>
      )}
    </LabelledSection>
  )
}

const tabClass = `${tabTriggerClass} px-3`

export const RolesSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => (
  <Root defaultValue={workspaceRoleKind.title} className="flex flex-col gap-4">
    <List aria-label="Role lists" className="flex gap-2 border-b border-line">
      {[workspaceRoleKind.title, chatRoleKind.title].map((title) => (
        <Trigger key={title} value={title} className={tabClass}>
          {title}
        </Trigger>
      ))}
    </List>
    <Content value={workspaceRoleKind.title}>
      <RoleList kind={workspaceRoleKind} workspaceId={workspaceId} />
    </Content>
    <Content value={chatRoleKind.title}>
      <RoleList kind={chatRoleKind} workspaceId={workspaceId} />
    </Content>
  </Root>
)
