import { useQuery } from '@spyria/db/react'
import { type MemberId, memberId as toMemberId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  focusRing,
  ghostButtonClass,
  iconButtonClass,
  labelClass,
  useGuardedAction,
  useNotifiedRun,
} from '@spyria/ui'
import { LogOut, UserPlus, X } from 'lucide-react'
import { type SubmitEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { getMembers } from '../queries/get-members.ts'
import { usePanelCommands } from './providers.tsx'
import type { TabProps } from './TabProps.ts'

type Option = { value: string; label: string }

const roleSelectClass = `rounded-md bg-raised bg-[position:right_0.25rem_center] py-0.5 pr-6 pl-1.5 text-xs text-muted hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`
const memberActionClass = `${iconButtonClass} disabled:cursor-not-allowed disabled:opacity-60`

const optionsOf = (options: readonly Option[]) =>
  options.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ))

const InviteForm = ({
  invitees,
  roles,
  invite,
  isPending,
  onClose,
}: {
  invitees: readonly Option[]
  roles: readonly Option[]
  invite: (memberId: MemberId, roleId: string) => Promise<boolean>
  isPending: boolean
  onClose: () => void
}) => {
  const [memberId, setMemberId] = useState(invitees[0]?.value ?? '')
  const [roleId, setRoleId] = useState(roles.at(-1)?.value ?? '')
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await invite(toMemberId(memberId), roleId)) onClose()
  }
  return (
    <form aria-label="Invite" onSubmit={submit} className="flex flex-col gap-3">
      <label className={labelClass}>
        Member
        <select className={fieldClass} value={memberId} onChange={(event) => setMemberId(event.target.value)}>
          {optionsOf(invitees)}
        </select>
      </label>
      <label className={labelClass}>
        Role
        <select className={fieldClass} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          {optionsOf(roles)}
        </select>
      </label>
      <div className="flex gap-2">
        <button type="submit" className={buttonClass} disabled={isPending}>
          Add to chat
        </button>
        <button type="button" className={ghostButtonClass} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

const MembersTab = ({ workspaceId, chatId, actionsSlot }: TabProps) => {
  const { memberId: viewerId } = useSession()
  const view = useQuery(getMembers, workspaceId, chatId, viewerId)
  const commands = usePanelCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const runNotified = useNotifiedRun(run)
  const [isInviting, setIsInviting] = useState(false)
  if (!view) return null
  const target = { workspaceId, chatId }
  const roleOptions = (roles: typeof view.assignableRoles) => roles.map(({ id, name }) => ({ value: id, label: name }))
  const roleNameOf = (roleId: string) => view.assignableRoles.find((role) => role.id === roleId)?.name ?? roleId
  const nameOf = (memberId: MemberId) =>
    view.invitees.find((invitee) => invitee.memberId === memberId)?.name ?? 'Member'
  const canInvite = view.invitableRoles.length > 0 && view.invitees.length > 0
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2 text-sm">
        {view.members.map(({ memberId, name, roleId, role, isOwner }) => (
          <li key={memberId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span>{name}</span>
            {view.canManage && !isOwner ? (
              <span className="flex items-center gap-1">
                <select
                  aria-label={`Role of ${name}`}
                  className={roleSelectClass}
                  value={roleId}
                  disabled={isPending}
                  onChange={(event) =>
                    runNotified(
                      () => commands.changeMemberRole({ ...target, memberId, roleId: event.target.value }),
                      `${name} is now ${roleNameOf(event.target.value)}`,
                    )
                  }
                >
                  {optionsOf(roleOptions(view.assignableRoles))}
                </select>
                {view.canRemove && (
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name}`}
                    className={memberActionClass}
                    disabled={isPending}
                    onClick={() =>
                      runNotified(() => commands.removeMember({ ...target, memberId }), `${name} removed from the chat`)
                    }
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                )}
              </span>
            ) : (
              <span className="text-xs text-muted">{role}</span>
            )}
          </li>
        ))}
      </ul>
      {isInviting && canInvite && (
        <InviteForm
          invitees={view.invitees.map(({ memberId, name }) => ({ value: memberId, label: name }))}
          roles={roleOptions(view.invitableRoles)}
          invite={(memberId, roleId) =>
            runNotified(
              () => commands.inviteMember({ ...target, memberId, roleId }),
              `${nameOf(memberId)} added to the chat`,
            )
          }
          isPending={isPending}
          onClose={() => setIsInviting(false)}
        />
      )}
      {actionsSlot &&
        createPortal(
          <>
            {canInvite && (
              <button
                type="button"
                aria-label="Invite"
                title="Invite"
                aria-expanded={isInviting}
                onClick={() => setIsInviting(!isInviting)}
                className={memberActionClass}
              >
                <UserPlus aria-hidden className="size-4" />
              </button>
            )}
            {view.canLeave && (
              <button
                type="button"
                aria-label="Leave chat"
                title="Leave chat"
                disabled={isPending}
                onClick={() => runNotified(() => commands.leaveChat(target), 'You left the chat')}
                className={memberActionClass}
              >
                <LogOut aria-hidden className="size-4" />
              </button>
            )}
          </>,
          actionsSlot,
        )}
      <ErrorMessage message={errorMessage} />
    </div>
  )
}

export default MembersTab
