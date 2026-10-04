import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog } from '@hq/ui'
import { ErrorMessage } from './ErrorMessage.tsx'
import { useProfileCommands } from './providers.tsx'
import { useGuardedAction } from './useGuardedAction.ts'

export const RemoveCredentialDialog = ({
  workspaceId,
  memberId,
  credentialId,
  provider,
  onClose,
}: {
  workspaceId: WorkspaceId
  memberId: MemberId
  credentialId: CredentialId
  provider: string
  onClose: () => void
}) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const confirm = async () => {
    if (await run(() => commands.removeLlmCredential({ workspaceId, memberId, credentialId }))) onClose()
  }
  return (
    <Dialog label="Remove LLM key" subject={provider} onClose={onClose}>
      <ErrorMessage message={errorMessage} />
      <button type="button" className={buttonClass} onClick={confirm}>
        Remove
      </button>
    </Dialog>
  )
}
