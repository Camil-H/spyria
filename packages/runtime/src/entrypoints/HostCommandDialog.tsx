import { Dialog, ghostButtonClass } from '@hq/ui'
import { hostCommandOf, type SignInTool } from '../domain/host-command.ts'

export const PersonalNotice = ({ toolName }: { toolName?: string }) => (
  <p className="text-sm text-muted">
    {toolName
      ? `This runs HQ's agent container on this computer and signs in to ${toolName} with your own plan. The sign-in never leaves this computer.`
      : "This runs HQ's agent container on this computer. Your sign-ins never leave this computer."}{' '}
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
    <button type="button" className={ghostButtonClass} onClick={() => navigator.clipboard.writeText(command)}>
      Copy
    </button>
  </>
)

export const HostCommand = ({ code, personal, signIn }: { code: string; personal?: boolean; signIn?: SignInTool }) => (
  <>
    <p className="text-sm text-muted">
      Run this command in a terminal within 15 minutes{location.hostname === 'localhost' && ', from the HQ repo folder'}
      . The code works once.
    </p>
    <CommandBox command={hostCommandOf({ origin: location.origin, code, personal, signIn })} />
  </>
)

export const HostCommandDialog = ({
  label,
  code,
  personal = false,
  onClose,
}: {
  label: string
  code: string
  personal?: boolean
  onClose: () => void
}) => (
  <Dialog label={label} closeLabel="Close" onClose={onClose}>
    {personal && <PersonalNotice />}
    <HostCommand code={code} personal={personal} />
  </Dialog>
)
