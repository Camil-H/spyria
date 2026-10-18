import { useQuery } from '@hq/db/react'
import { type ChatPermission, type ChatRole, chatPermissions, type WorkspaceId } from '@hq/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  useGuardedAction,
} from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { listChatRoles } from '../queries/list-chat-roles.ts'
import { useWorkspaceCommands } from './providers.tsx'

const permissionLabels: Record<ChatPermission, string> = {
  'chat.read': 'Read the chat',
  'chat.post': 'Post and prompt the agent',
  'session.configure': 'Choose the model and stop the agent',
  'tools.manage': "Manage the chat's tools",
  'members.invite': 'Invite people to the chat',
  'members.manage': 'Change roles and remove people',
  'chat.admin': 'Rename, move and archive the chat, change its visibility',
}

type RoleInput = { name: string; permissions: readonly ChatPermission[] }

const RoleForm = ({
  label,
  role,
  save,
  onClose,
}: {
  label: string
  role?: ChatRole
  save: (input: RoleInput) => Promise<unknown>
  onClose: () => void
}) => {
  const [name, setName] = useState(role?.name ?? '')
  const [permissions, setPermissions] = useState<readonly ChatPermission[]>(role?.permissions ?? ['chat.read'])
  const { errorMessage, isPending, run } = useGuardedAction()
  const toggle = (permission: ChatPermission) =>
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
        {chatPermissions.map((permission) => (
          <label key={permission} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={permission === 'chat.read' || permissions.includes(permission)}
              disabled={permission === 'chat.read' || isPending}
              onChange={() => toggle(permission)}
            />
            {permissionLabels[permission]}
          </label>
        ))}
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

const CustomRoleActions = ({ workspaceId, role }: { workspaceId: WorkspaceId; role: ChatRole }) => {
  const commands = useWorkspaceCommands()
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
            label={`Edit ${role.name}`}
            role={role}
            save={(input) => commands.updateChatRole({ ...target, ...input })}
            onClose={() => setIsEditing(false)}
          />
        </div>
      )}
      {isDeleting && (
        <Dialog label="Delete role" subject={role.name} onClose={() => setIsDeleting(false)}>
          <p className="text-sm text-muted">A role still held in a chat cannot be deleted.</p>
          <ErrorMessage message={errorMessage} />
          <button
            type="button"
            className={buttonClass}
            disabled={isPending}
            onClick={() => run(() => commands.deleteChatRole(target))}
          >
            Delete
          </button>
        </Dialog>
      )}
    </>
  )
}

export const RolesSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const roles = useQuery(listChatRoles(workspaceId))
  const [isCreating, setIsCreating] = useState(false)
  return (
    <LabelledSection title="Chat roles">
      <p className="text-sm text-muted">
        Each chat gives its people one of these roles. Built-in roles are fixed; custom roles can be changed.
      </p>
      <ul aria-label="Chat roles" className="flex flex-col gap-3">
        {roles.map((role) => (
          <li key={role.id} aria-label={role.name} className="rounded-lg border border-line p-3">
            <h3 className="font-medium">{role.name}</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-muted">
              {role.permissions.map((permission) => (
                <li key={permission}>{permissionLabels[permission]}</li>
              ))}
            </ul>
            {!role.builtIn && <CustomRoleActions workspaceId={workspaceId} role={role} />}
          </li>
        ))}
      </ul>
      {isCreating ? (
        <RoleForm
          label="New role"
          save={(input) => commands.createChatRole({ workspaceId, ...input })}
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
