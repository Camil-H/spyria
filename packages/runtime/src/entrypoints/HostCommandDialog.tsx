import { Dialog, ghostButtonClass, Switch } from '@hq/ui'
import { useState } from 'react'
import { hostCommandOf } from '../domain/host-command.ts'

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
}) => {
  const [isRootless, setIsRootless] = useState(true)
  const command = hostCommandOf({ origin: location.origin, code, rootless: isRootless, personal })
  return (
    <Dialog label={label} closeLabel="Close" onClose={onClose}>
      <p className="text-sm text-muted">Run this command on the host within 15 minutes. The code works once.</p>
      {personal && (
        <p className="text-sm text-muted">
          The agent on this machine can read your Claude and Codex sign-ins, as Claude Code and Codex can on your
          laptop. HQ removes tokens from what it receives, but never run it on a machine others use.
        </p>
      )}
      <Switch label="Rootless Docker" isOn={isRootless} onToggle={() => setIsRootless(!isRootless)} />
      <textarea
        readOnly
        aria-label="Command"
        rows={7}
        value={command}
        className="resize-none rounded-md border border-line bg-app p-2 font-mono text-xs text-ink"
      />
      <button type="button" className={ghostButtonClass} onClick={() => navigator.clipboard.writeText(command)}>
        Copy
      </button>
    </Dialog>
  )
}
