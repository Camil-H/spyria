import type { Snapshot } from '@spyria/db'
import { useQuery } from '@spyria/db/react'
import {
  type ChatPermission,
  chatPermissions,
  type WorkspaceId,
  type WorkspacePermission,
  workspacePermissionLabels,
  workspacePermissions,
} from '@spyria/kernel'
import {
  buttonClass,
  cardClass,
  Dialog,
  dangerButtonClass,
  ErrorMessage,
  fieldClass,
  labelClass,
  RowMenu,
  SegmentedChoice,
  useGuardedAction,
} from '@spyria/ui'
import { Check } from 'lucide-react'
import { type ReactNode, type SubmitEvent, useState } from 'react'
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

const RoleFormDialog = <Permission extends string>({
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
    <Dialog label={label} isWide onClose={onClose}>
      <form aria-label={label} onSubmit={submit} className="flex flex-col gap-4">
        <label className={labelClass}>
          Name
          <input
            data-initial-focus
            className={fieldClass}
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="mb-1 text-sm text-muted">Permissions</legend>
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
        <button type="submit" className={buttonClass} disabled={isPending || name.trim() === ''}>
          Save
        </button>
      </form>
    </Dialog>
  )
}

const DeleteRoleDialog = <Permission extends string>({
  kind,
  role,
  remove,
  onClose,
}: {
  kind: RoleKind<Permission>
  role: StoredRole<Permission>
  remove: () => Promise<unknown>
  onClose: () => void
}) => {
  const { errorMessage, isPending, run } = useGuardedAction()
  return (
    <Dialog label="Delete role" subject={role.name} onClose={onClose}>
      <p className="text-sm text-muted">{kind.deletionHint}</p>
      <ErrorMessage message={errorMessage} />
      <button type="button" className={dangerButtonClass} disabled={isPending} onClick={() => run(remove)}>
        Delete
      </button>
    </Dialog>
  )
}

type OpenRoleDialog<Permission extends string> =
  | { kind: 'create' }
  | { kind: 'edit'; role: StoredRole<Permission> }
  | { kind: 'delete'; role: StoredRole<Permission> }
  | null

const PermissionCell = ({ isAllowed }: { isAllowed: boolean }) =>
  isAllowed ? (
    <Check role="img" aria-label="Allowed" className="mx-auto size-4 text-agent-done" />
  ) : (
    <span role="img" aria-label="Not allowed" className="block text-center text-muted">
      –
    </span>
  )

const RoleGrid = <Permission extends string>({
  kind,
  workspaceId,
  kindChoice,
}: {
  kind: RoleKind<Permission>
  workspaceId: WorkspaceId
  kindChoice: ReactNode
}) => {
  const commands = kind.commandsOf(useWorkspaceCommands())
  const roles = useQuery(kind.listRoles, workspaceId)
  const [openDialog, setOpenDialog] = useState<OpenRoleDialog<Permission>>(null)
  const closeDialog = () => setOpenDialog(null)
  return (
    <section aria-label={kind.title} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {kindChoice}
        <button type="button" className={buttonClass} onClick={() => setOpenDialog({ kind: 'create' })}>
          New role
        </button>
      </div>
      <p className="text-sm text-muted">{kind.description}</p>
      <div className={`${cardClass} overflow-x-auto`}>
        <table aria-label={kind.title} className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-muted">
                Permission
              </th>
              {roles.map((role) => (
                <th
                  key={role.id}
                  scope="col"
                  aria-label={role.name}
                  className="min-w-28 px-3 py-2 text-center font-medium"
                >
                  <span className="inline-flex items-center gap-1">
                    {role.name}
                    {!role.builtIn && (
                      <RowMenu
                        label={`Actions for ${role.name}`}
                        items={[
                          { label: 'Edit', onSelect: () => setOpenDialog({ kind: 'edit', role }) },
                          { label: 'Delete', onSelect: () => setOpenDialog({ kind: 'delete', role }) },
                        ]}
                      />
                    )}
                  </span>
                  <span className="block text-xs font-normal text-muted">{role.builtIn ? 'Built-in' : 'Custom'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {kind.permissions.map((permission) => (
              <tr key={permission} className="hover:bg-hover">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  {kind.labels[permission]}
                </th>
                {roles.map((role) => (
                  <td key={role.id} className="px-3 py-2">
                    <PermissionCell isAllowed={role.permissions.includes(permission)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {openDialog?.kind === 'create' && (
        <RoleFormDialog
          kind={kind}
          label="New role"
          save={(input) => commands.create({ workspaceId, ...input })}
          onClose={closeDialog}
        />
      )}
      {openDialog?.kind === 'edit' && (
        <RoleFormDialog
          kind={kind}
          label={`Edit ${openDialog.role.name}`}
          role={openDialog.role}
          save={(input) => commands.update({ workspaceId, roleId: openDialog.role.id, ...input })}
          onClose={closeDialog}
        />
      )}
      {openDialog?.kind === 'delete' && (
        <DeleteRoleDialog
          kind={kind}
          role={openDialog.role}
          remove={async () => {
            await commands.remove({ workspaceId, roleId: openDialog.role.id })
            closeDialog()
          }}
          onClose={closeDialog}
        />
      )}
    </section>
  )
}

const roleKindTitles = [workspaceRoleKind.title, chatRoleKind.title] as const
type RoleKindTitle = (typeof roleKindTitles)[number]

export const RolesSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const [shown, setShown] = useState<RoleKindTitle>(workspaceRoleKind.title)
  const kindChoice = (
    <SegmentedChoice
      label="Role lists"
      name="role-kind"
      options={roleKindTitles}
      labels={{ [workspaceRoleKind.title]: workspaceRoleKind.title, [chatRoleKind.title]: chatRoleKind.title }}
      value={shown}
      onChange={setShown}
    />
  )
  return shown === workspaceRoleKind.title ? (
    <RoleGrid kind={workspaceRoleKind} workspaceId={workspaceId} kindChoice={kindChoice} />
  ) : (
    <RoleGrid kind={chatRoleKind} workspaceId={workspaceId} kindChoice={kindChoice} />
  )
}
