import { useQuery } from '@hq/db/react'
import { type ChatId, memberId as toMemberId, type WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, ErrorMessage, fieldClass, useGuardedAction } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { listMembers } from '../queries/list-members.ts'
import { useWorkspaceCommands } from './providers.tsx'
import { useIsWorkspaceAdmin } from './useIsWorkspaceAdmin.ts'

export const TransferChatForm = ({ workspaceId, chatId }: { workspaceId: WorkspaceId; chatId: ChatId }) => {
  const commands = useWorkspaceCommands()
  const { memberId } = useSession()
  const isAdmin = useIsWorkspaceAdmin(workspaceId)
  const members = useQuery(listMembers(workspaceId))
  const [ownerId, setOwnerId] = useState<string>(memberId)
  const { errorMessage, isPending, run } = useGuardedAction()
  if (!isAdmin) return null
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    await run(() => commands.transferChat({ workspaceId, chatId, ownerId: toMemberId(ownerId) }))
  }
  return (
    <form aria-label="Transfer chat" onSubmit={submit} className="flex flex-wrap items-center justify-center gap-2">
      <select
        aria-label="Transfer to"
        className={fieldClass}
        value={ownerId}
        onChange={(event) => setOwnerId(event.target.value)}
      >
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </select>
      <button type="submit" className={buttonClass} disabled={isPending}>
        Transfer
      </button>
      <ErrorMessage message={errorMessage} />
    </form>
  )
}
