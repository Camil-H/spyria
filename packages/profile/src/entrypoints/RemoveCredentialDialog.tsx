import type { CredentialId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, ErrorMessage, useGuardedAction } from '@hq/ui'
import { useProfileCommands } from './providers.tsx'

export const RemoveCredentialDialog = ({
  workspaceId,
  credentialId,
  provider,
  onClose,
}: {
  workspaceId: WorkspaceId
  credentialId: CredentialId
  provider: string
  onClose: () => void
}) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const confirm = async () => {
    if (await run(() => commands.removeLlmCredential({ workspaceId, credentialId }))) onClose()
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
