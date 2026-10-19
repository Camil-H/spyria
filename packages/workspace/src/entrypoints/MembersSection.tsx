import { useQuery } from '@spyria/db/react'
import { canGrantWorkspaceRole, memberRoleId, type WorkspaceId, type WorkspaceRole } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  useGuardedAction,
} from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { listInvitations, listMembers, type WorkspaceMember } from '../queries/list-members.ts'
import { listWorkspaceRoles } from '../queries/list-roles.ts'
import { useWorkspaceCommands } from './providers.tsx'
import { useWorkspacePermissions } from './useWorkspacePermissions.ts'

const dayMilliseconds = 24 * 60 * 60 * 1000

const expiryLabelOf = (expiresAt: number) => {
  const days = Math.ceil((expiresAt - Date.now()) / dayMilliseconds)
  if (days <= 0) return 'Expired'
  return days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`
}

const RoleSelect = ({
  label,
  role,
  roles,
  isDisabled,
  onChange,
}: {
  label: string
  role: string
  roles: readonly WorkspaceRole[]
  isDisabled?: boolean
  onChange: (role: string) => void
}) => (
  <select
    aria-label={label}
    className={fieldClass}
    value={role}
    disabled={isDisabled}
    onChange={(event) => onChange(event.target.value)}
  >
    {roles.map((option) => (
      <option key={option.id} value={option.id}>
        {option.name}
      </option>
    ))}
  </select>
)

const InviteForm = ({ workspaceId, roles }: { workspaceId: WorkspaceId; roles: readonly WorkspaceRole[] }) => {
  const commands = useWorkspaceCommands()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>(memberRoleId)
  const { errorMessage, isPending, run } = useGuardedAction()
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await run(() => commands.inviteMember({ workspaceId, email, role }))) setEmail('')
  }
  return (
    <form aria-label="Invite member" onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className={`${labelClass} min-w-56 flex-1`}>
        Email
        <input type="email" className={fieldClass} value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <RoleSelect label="Role" role={role} roles={roles} onChange={setRole} />
      <button type="submit" className={buttonClass} disabled={isPending || email.trim() === ''}>
        Invite
      </button>
      <div className="basis-full">
        <ErrorMessage message={errorMessage} />
      </div>
    </form>
  )
}

export const MembersSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const { memberId: viewerId } = useSession()
  const members = useQuery(listMembers(workspaceId))
  const invitations = useQuery(listInvitations(workspaceId))
  const roles = useQuery(listWorkspaceRoles(workspaceId))
  const permissions = useWorkspacePermissions(workspaceId)
  const grantableRoles = roles.filter((role) => canGrantWorkspaceRole(permissions, role))
  const roleNameOf = (roleId: string) => roles.find((role) => role.id === roleId)?.name ?? roleId
  const canManage = (member: WorkspaceMember) =>
    member.id !== viewerId &&
    permissions.includes('members.manage') &&
    grantableRoles.some((role) => role.id === member.role)
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null)
  const { errorMessage, isPending, run } = useGuardedAction()
  const remove = async (member: WorkspaceMember) => {
    if (await run(() => commands.removeMember({ workspaceId, memberId: member.id }))) setRemoving(null)
  }
  return (
    <LabelledSection title="Members">
      <ul aria-label="Members" className="flex flex-col gap-2 text-sm">
        {members.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{member.name}</span>
            <span className="text-muted">{member.email}</span>
            {!canManage(member) ? (
              <span className="ml-auto text-muted">
                {roleNameOf(member.role)}
                {member.id === viewerId && ' (you)'}
              </span>
            ) : (
              <span className="ml-auto flex items-center gap-2">
                <RoleSelect
                  label={`Role of ${member.name}`}
                  role={member.role}
                  roles={grantableRoles}
                  isDisabled={isPending}
                  onChange={(role) => run(() => commands.changeMemberRole({ workspaceId, memberId: member.id, role }))}
                />
                <button
                  type="button"
                  aria-label={`Remove ${member.name}`}
                  className={ghostButtonClass}
                  disabled={isPending}
                  onClick={() => setRemoving(member)}
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {!removing && <ErrorMessage message={errorMessage} />}
      {invitations.length > 0 && (
        <ul aria-label="Pending invites" className="flex flex-col gap-2 text-sm">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{invitation.email}</span>
              <span className="text-muted">{roleNameOf(invitation.role)}</span>
              <span className="text-muted">{expiryLabelOf(invitation.expiresAt)}</span>
              <button
                type="button"
                aria-label={`Revoke the invite of ${invitation.email}`}
                className={`ml-auto ${ghostButtonClass}`}
                disabled={isPending}
                onClick={() => run(() => commands.revokeInvite({ workspaceId, invitationId: invitation.id }))}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {permissions.includes('members.invite') && <InviteForm workspaceId={workspaceId} roles={grantableRoles} />}
      {removing && (
        <Dialog label="Remove member" subject={removing.name} onClose={() => setRemoving(null)}>
          <p className="text-sm text-muted">
            They lose access at once. The runtime chats they own freeze until someone who manages members transfers
            them.
          </p>
          <ErrorMessage message={errorMessage} />
          <button type="button" className={buttonClass} disabled={isPending} onClick={() => remove(removing)}>
            Remove
          </button>
        </Dialog>
      )}
    </LabelledSection>
  )
}
