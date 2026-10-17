import { useQuery } from '@hq/db/react'
import { type MemberId, memberId as toMemberId } from '@hq/kernel'
import { useSession } from '@hq/session'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  focusRing,
  ghostButtonClass,
  labelClass,
  useGuardedAction,
} from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { getMembers } from '../queries/get-members.ts'
import { usePanelCommands } from './providers.tsx'
import type { TabProps } from './TabProps.ts'

type Option = { value: string; label: string }

const removeButtonClass = `rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink ${focusRing}`

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
  onClose,
}: {
  invitees: readonly Option[]
  roles: readonly Option[]
  invite: (memberId: MemberId, roleId: string) => Promise<boolean>
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
        <button type="submit" className={buttonClass}>
          Add to chat
        </button>
        <button type="button" className={ghostButtonClass} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

const MembersTab = ({ workspaceId, chatId }: TabProps) => {
  const { memberId: viewerId } = useSession()
  const view = useQuery(getMembers(workspaceId, chatId, viewerId))
  const commands = usePanelCommands()
  const { errorMessage, run } = useGuardedAction()
  const [isInviting, setIsInviting] = useState(false)
  if (!view) return null
  const target = { workspaceId, chatId }
  const roleOptions = (roles: typeof view.assignableRoles) => roles.map(({ id, name }) => ({ value: id, label: name }))
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
                  className={fieldClass}
                  value={roleId}
                  onChange={(event) =>
                    run(() => commands.changeMemberRole({ ...target, memberId, roleId: event.target.value }))
                  }
                >
                  {optionsOf(roleOptions(view.assignableRoles))}
                </select>
                {view.canRemove && (
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    className={removeButtonClass}
                    onClick={() => run(() => commands.removeMember({ ...target, memberId }))}
                  >
                    Remove
                  </button>
                )}
              </span>
            ) : (
              <span className="text-xs text-muted">{role}</span>
            )}
          </li>
        ))}
      </ul>
      {canInvite &&
        (isInviting ? (
          <InviteForm
            invitees={view.invitees.map(({ memberId, name }) => ({ value: memberId, label: name }))}
            roles={roleOptions(view.invitableRoles)}
            invite={(memberId, roleId) => run(() => commands.inviteMember({ ...target, memberId, roleId }))}
            onClose={() => setIsInviting(false)}
          />
        ) : (
          <button type="button" className={`${ghostButtonClass} self-start`} onClick={() => setIsInviting(true)}>
            Invite
          </button>
        ))}
      {view.canLeave && (
        <button
          type="button"
          className={`${ghostButtonClass} self-start`}
          onClick={() => run(() => commands.leaveChat(target))}
        >
          Leave chat
        </button>
      )}
      <ErrorMessage message={errorMessage} />
    </div>
  )
}

export default MembersTab
