import type { HarnessId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { CopyButton, Dialog, ghostButtonClass } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { hostCommandOf } from '../domain/host-command.ts'

export const useCloseOnceDone = (isDone: boolean, close: () => void) => {
  const [wasDoneWhenOpened] = useState(isDone)
  useEffect(() => {
    if (isDone && !wasDoneWhenOpened) close()
  }, [isDone, wasDoneWhenOpened, close])
}

export const PersonalNotice = ({ toolName }: { toolName?: string }) => (
  <p className="text-sm text-muted">
    {toolName
      ? `This runs Spyria's agent container on this computer and signs in to ${toolName} with your own plan. The sign-in never leaves this computer.`
      : "This runs Spyria's agent container on this computer. Your sign-ins never leave this computer."}{' '}
    <strong className="text-ink">Never run it on a machine others use.</strong>
  </p>
)

export const CommandBox = ({ command }: { command: string }) => (
  <>
    <textarea
      readOnly
      aria-label="Command"
      rows={7}
      value={command}
      className="resize-none overflow-auto rounded-md border border-line bg-app p-2 font-mono text-xs text-ink"
    />
    <CopyButton text={command} className={ghostButtonClass} />
  </>
)

export const HostCommand = ({ code, personal, signIn }: { code: string; personal?: boolean; signIn?: HarnessId }) => {
  const { deployment } = useSession()
  return (
    <>
      <p className="text-sm text-muted">
        Run this command in a terminal within 15 minutes
        {location.hostname === 'localhost' && ', from the Spyria repo folder'}. The code works once.
      </p>
      <CommandBox command={hostCommandOf({ deployment, origin: location.origin, code, personal, signIn })} />
    </>
  )
}

export const HostCommandDialog = ({
  label,
  code,
  personal = false,
  isConnected,
  onClose,
}: {
  label: string
  code: string
  personal?: boolean
  isConnected: boolean
  onClose: () => void
}) => {
  useCloseOnceDone(isConnected, onClose)
  return (
    <Dialog label={label} closeLabel="Close" onClose={onClose}>
      {personal && <PersonalNotice />}
      <HostCommand code={code} personal={personal} />
    </Dialog>
  )
}
