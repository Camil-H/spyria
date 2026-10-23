import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  Dialog,
  dangerButtonClass,
  ErrorMessage,
  fieldClass,
  LabelledSection,
  labelClass,
  useGuardedAction,
} from '@spyria/ui'
import { useState } from 'react'
import { workspaceDeletionGraceMilliseconds } from '../domain/workspace.ts'
import { getDeletableWorkspace } from '../queries/get-deletable-workspace.ts'
import { useWorkspaceCommands } from './providers.tsx'

const confirmationWord = 'DELETE'

export const DeleteWorkspaceSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const workspace = useQuery(getDeletableWorkspace, workspaceId, useSession().memberId)
  const commands = useWorkspaceCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [isConfirming, setIsConfirming] = useState(false)
  const [typedWord, setTypedWord] = useState('')
  if (!workspace) return null
  const close = () => {
    setIsConfirming(false)
    setTypedWord('')
  }
  const erasedOn = new Date(Date.now() + workspaceDeletionGraceMilliseconds).toLocaleDateString(undefined, {
    dateStyle: 'long',
  })
  return (
    <LabelledSection title="Delete workspace">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-raised p-4">
        <p className="max-w-xl text-sm text-muted">
          Everyone loses access at once. Seven days later, everything in {workspace.name} is erased for good.
        </p>
        <button type="button" className={dangerButtonClass} onClick={() => setIsConfirming(true)}>
          Delete workspace
        </button>
      </div>
      {isConfirming && (
        <Dialog label="Delete workspace" subject={workspace.name} onClose={close}>
          <p className="text-sm text-muted">
            Every member loses access at once and running agents stop. On {erasedOn}, Spyria erases the chats and their
            history, the runtimes and their files, the members' model keys, the shared connections, the link to the
            GitHub App, the sign-in settings and the email domain. Until then, the operator of this Spyria can restore
            the workspace.
          </p>
          <p className="text-sm text-muted">The GitHub App stays installed on GitHub: uninstall it there.</p>
          <label className={labelClass}>
            Type {confirmationWord} to confirm
            <input
              className={fieldClass}
              autoComplete="off"
              value={typedWord}
              onChange={(event) => setTypedWord(event.target.value)}
            />
          </label>
          <ErrorMessage message={errorMessage} />
          <button
            type="button"
            className={dangerButtonClass}
            disabled={typedWord !== confirmationWord || isPending}
            onClick={() => run(() => commands.deleteWorkspace({ workspaceId, confirmation: confirmationWord }))}
          >
            Delete workspace
          </button>
        </Dialog>
      )}
    </LabelledSection>
  )
}
