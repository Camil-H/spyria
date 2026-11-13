import type { WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  ghostButtonClass,
  LabelledSection,
  rowClass,
  rowListClass,
  useGuardedAction,
} from '@spyria/ui'
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
    <LabelledSection title="Sessions">
      <p className="-mt-2 text-sm text-muted">Where you are signed in to this workspace</p>
      <ul aria-label="Sessions" className={rowListClass}>
        {sessions.map((session) => (
          <li key={`${session.signedInAt} ${session.userAgent} ${session.isCurrent}`} className={rowClass}>
            <span className="font-medium">{deviceNameOf(session.userAgent)}</span>
            <span className="text-muted">{signedInLabelOf(session.signedInAt)}</span>
            {session.isCurrent && (
              <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                This device
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className={`${rowListClass} mt-4`}>
        <div className={rowClass}>
          <span className="flex flex-col">
            <span className="font-medium">End every session</span>
            <span className="text-muted">Ends every session, this one included</span>
          </span>
          <button type="button" className={`ml-auto ${ghostButtonClass}`} onClick={() => setIsConfirming(true)}>
            Sign out everywhere
          </button>
        </div>
      </div>
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
