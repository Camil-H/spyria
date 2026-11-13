import type { Snapshot } from '@spyria/db'
import { useQuery } from '@spyria/db/react'
import { canGrantWorkspaceRole, memberRoleId, type WorkspaceId, type WorkspaceRole } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  buttonClass,
  cardClass,
  Dialog,
  dangerButtonClass,
  ErrorMessage,
  fieldClass,
  LabelledSection,
  labelClass,
  RowMenu,
  rowClass,
  rowHeaderClass,
  rowListClass,
  smallGhostButtonClass,
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
    className={`${fieldClass} w-full`}
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

const InviteDialog = ({
  workspaceId,
  roles,
  onClose,
}: {
  workspaceId: WorkspaceId
  roles: readonly WorkspaceRole[]
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>(memberRoleId)
  const { errorMessage, isPending, run } = useGuardedAction()
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await run(() => commands.inviteMember({ workspaceId, email, role }))) onClose()
  }
  return (
    <Dialog label="Invite member" onClose={onClose}>
      <form aria-label="Invite member" onSubmit={submit} className="flex flex-col gap-3">
        <label className={labelClass}>
          Email
          <input
            type="email"
            data-initial-focus
            className={fieldClass}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <div className={labelClass}>
          <span aria-hidden>Role</span>
          <RoleSelect label="Role" role={role} roles={roles} onChange={setRole} />
        </div>
        <p className="text-xs text-muted">
          No email is sent: they get in the next time they sign in with this address.
        </p>
        <ErrorMessage message={errorMessage} />
        <button type="submit" className={buttonClass} disabled={isPending || email.trim() === ''}>
          Invite
        </button>
      </form>
    </Dialog>
  )
}

const PendingInvites = ({
  workspaceId,
  invitations,
  roleNameOf,
}: {
  workspaceId: WorkspaceId
  invitations: Snapshot['invitations']
  roleNameOf: (roleId: string) => string
}) => {
  const commands = useWorkspaceCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  return (
    <LabelledSection title={`Pending invites · ${invitations.length}`} Heading="h3" titleClass="text-sm font-medium">
      <ul aria-label="Pending invites" className={rowListClass}>
        {invitations.map((invitation) => (
          <li key={invitation.id} className={rowClass}>
            <span className="min-w-0 flex-1 truncate font-medium">{invitation.email}</span>
            <span className="w-32 text-muted">{roleNameOf(invitation.role)}</span>
            <span className="w-32 text-muted">{expiryLabelOf(invitation.expiresAt)}</span>
            <button
              type="button"
              aria-label={`Revoke the invite of ${invitation.email}`}
              className={smallGhostButtonClass}
              disabled={isPending}
              onClick={() => run(() => commands.revokeInvite({ workspaceId, invitationId: invitation.id }))}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}

export const MembersSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const { memberId: viewerId } = useSession()
  const members = useQuery(listMembers, workspaceId)
  const invitations = useQuery(listInvitations, workspaceId)
  const roles = useQuery(listWorkspaceRoles, workspaceId)
  const permissions = useWorkspacePermissions(workspaceId)
  const grantableRoles = roles.filter((role) => canGrantWorkspaceRole(permissions, role))
  const roleNameOf = (roleId: string) => roles.find((role) => role.id === roleId)?.name ?? roleId
  const canManage = (member: WorkspaceMember) =>
    member.id !== viewerId &&
    permissions.includes('members.manage') &&
    grantableRoles.some((role) => role.id === member.role)
  const [isInviting, setIsInviting] = useState(false)
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null)
  const [signingOut, setSigningOut] = useState<WorkspaceMember | null>(null)
  const { errorMessage, isPending, run } = useGuardedAction()
  const remove = async (member: WorkspaceMember) => {
    if (await run(() => commands.removeMember({ workspaceId, memberId: member.id }))) setRemoving(null)
  }
  const signOutEverywhere = async (member: WorkspaceMember) => {
    if (await run(() => commands.endMemberSessions({ workspaceId, memberId: member.id }))) setSigningOut(null)
  }
  return (
    <section aria-label="Members" className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Everyone in this workspace and the role each one holds</p>
        {permissions.includes('members.invite') && (
          <button type="button" className={buttonClass} onClick={() => setIsInviting(true)}>
            Invite member
          </button>
        )}
      </div>
      <div className={`${cardClass} divide-y divide-line`}>
        <div aria-hidden className={rowHeaderClass}>
          <span className="flex-1">Name</span>
          <span className="w-44">Role</span>
          <span className="w-8" />
        </div>
        <ul aria-label="Members" className="flex flex-col divide-y divide-line">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-x-3 px-4 py-3 text-sm">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">
                  {member.name}
                  {member.id === viewerId && <span className="font-normal text-muted"> (you)</span>}
                </span>
                <span className="truncate text-muted">{member.email}</span>
              </span>
              <span className="w-44">
                {canManage(member) ? (
                  <RoleSelect
                    label={`Role of ${member.name}`}
                    role={member.role}
                    roles={grantableRoles}
                    isDisabled={isPending}
                    onChange={(role) =>
                      run(() => commands.changeMemberRole({ workspaceId, memberId: member.id, role }))
                    }
                  />
                ) : (
                  <span className="text-muted">{roleNameOf(member.role)}</span>
                )}
              </span>
              <span className="w-8">
                {canManage(member) && (
                  <RowMenu
                    label={`Actions for ${member.name}`}
                    items={[
                      { label: 'Sign out everywhere', onSelect: () => setSigningOut(member) },
                      { label: 'Remove from workspace', onSelect: () => setRemoving(member) },
                    ]}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {!removing && !signingOut && <ErrorMessage message={errorMessage} />}
      {invitations.length > 0 && (
        <PendingInvites workspaceId={workspaceId} invitations={invitations} roleNameOf={roleNameOf} />
      )}
      {isInviting && (
        <InviteDialog workspaceId={workspaceId} roles={grantableRoles} onClose={() => setIsInviting(false)} />
      )}
      {removing && (
        <Dialog label="Remove member" subject={removing.name} onClose={() => setRemoving(null)}>
          <p className="text-sm text-muted">
            They lose access at once. The runtime chats they own freeze until someone who manages members transfers
            them.
          </p>
          <ErrorMessage message={errorMessage} />
          <button type="button" className={dangerButtonClass} disabled={isPending} onClick={() => remove(removing)}>
            Remove
          </button>
        </Dialog>
      )}
      {signingOut && (
        <Dialog label="Sign out everywhere" subject={signingOut.name} onClose={() => setSigningOut(null)}>
          <p className="text-sm text-muted">
            They are signed out of this workspace on every device and their open agent views close. They stay a member
            and can sign in again.
          </p>
          <ErrorMessage message={errorMessage} />
          <button
            type="button"
            className={buttonClass}
            disabled={isPending}
            onClick={() => signOutEverywhere(signingOut)}
          >
            Sign out everywhere
          </button>
        </Dialog>
      )}
    </section>
  )
}
