import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, Dialog, ErrorMessage, ghostButtonClass, LabelledSection, useGuardedAction } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { type ActiveSession, deviceNameOf } from '../domain/active-session.ts'
import { useProfileCommands } from './providers.tsx'

const signedInLabelOf = (signedInAt: number) =>
  `Signed in ${new Date(signedInAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`

export const ActiveSessionsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const [sessions, setSessions] = useState<readonly ActiveSession[]>([])
  const [isConfirming, setIsConfirming] = useState(false)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.readActiveSessions({ workspaceId }).then(setSessions, () => setSessions([]))
  }, [commands, workspaceId])
  return (
    <LabelledSection id="sessions" title="Sessions">
      <ul aria-label="Sessions" className="flex flex-col gap-2 text-sm">
        {sessions.map((session) => (
          <li
            key={`${session.signedInAt} ${session.userAgent} ${session.isCurrent}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span className="font-medium">{deviceNameOf(session.userAgent)}</span>
            <span className="text-muted">{signedInLabelOf(session.signedInAt)}</span>
            {session.isCurrent && <span className="ml-auto text-muted">This device</span>}
          </li>
        ))}
      </ul>
      <button type="button" className={`self-start ${ghostButtonClass}`} onClick={() => setIsConfirming(true)}>
        Sign out everywhere
      </button>
      {isConfirming && (
        <Dialog label="Sign out everywhere" onClose={() => setIsConfirming(false)}>
          <p className="text-sm text-muted">
            You are signed out of this workspace on every device, this one included, and your open agent views close.
            Sign in again to come back.
          </p>
          <ErrorMessage message={errorMessage} />
          <button
            type="button"
            className={buttonClass}
            disabled={isPending}
            onClick={() => run(() => commands.signOutEverywhere({ workspaceId }))}
          >
            Sign out everywhere
          </button>
        </Dialog>
      )}
    </LabelledSection>
  )
}
