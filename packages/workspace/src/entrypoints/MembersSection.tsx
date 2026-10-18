import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
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
import type { WorkspaceRole } from '../domain/member.ts'
import { listInvitations, listMembers, type WorkspaceMember } from '../queries/list-members.ts'
import { useWorkspaceCommands } from './providers.tsx'

const roleLabels: Record<WorkspaceRole, string> = { admin: 'Admin', member: 'Member' }
const dayMilliseconds = 24 * 60 * 60 * 1000

const expiryLabelOf = (expiresAt: number) => {
  const days = Math.ceil((expiresAt - Date.now()) / dayMilliseconds)
  if (days <= 0) return 'Expired'
  return days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`
}

const RoleSelect = ({
  label,
  role,
  isDisabled,
  onChange,
}: {
  label: string
  role: WorkspaceRole
  isDisabled?: boolean
  onChange: (role: WorkspaceRole) => void
}) => (
  <select
    aria-label={label}
    className={fieldClass}
    value={role}
    disabled={isDisabled}
    onChange={(event) => onChange(event.target.value as WorkspaceRole)}
  >
    {Object.entries(roleLabels).map(([value, roleLabel]) => (
      <option key={value} value={value}>
        {roleLabel}
      </option>
    ))}
  </select>
)

const InviteForm = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
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
      <RoleSelect label="Role" role={role} onChange={setRole} />
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
            {member.id === viewerId ? (
              <span className="ml-auto text-muted">{roleLabels[member.role]} (you)</span>
            ) : (
              <span className="ml-auto flex items-center gap-2">
                <RoleSelect
                  label={`Role of ${member.name}`}
                  role={member.role}
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
              <span className="text-muted">{roleLabels[invitation.role]}</span>
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
      <InviteForm workspaceId={workspaceId} />
      {removing && (
        <Dialog label="Remove member" subject={removing.name} onClose={() => setRemoving(null)}>
          <p className="text-sm text-muted">
            They lose access at once. The runtime chats they own freeze until an admin transfers them.
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
