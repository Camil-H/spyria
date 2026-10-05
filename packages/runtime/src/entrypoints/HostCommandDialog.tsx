import { Dialog, ghostButtonClass } from '@hq/ui'
import { useState } from 'react'
import { hostCommandOf } from '../domain/host-command.ts'

export const HostCommandDialog = ({ label, code, onClose }: { label: string; code: string; onClose: () => void }) => {
  const [isRootless, setIsRootless] = useState(true)
  const command = hostCommandOf({ origin: location.origin, code, rootless: isRootless })
  return (
    <Dialog label={label} closeLabel="Close" onClose={onClose}>
      <p className="text-sm text-muted">Run this command on the host within 15 minutes. The code works once.</p>
      <label className="flex items-center justify-between gap-3 text-sm">
        Rootless Docker
        <button
          type="button"
          role="switch"
          aria-checked={isRootless}
          aria-label="Rootless Docker"
          onClick={() => setIsRootless(!isRootless)}
          className={`h-5 w-9 rounded-full p-0.5 ${isRootless ? 'bg-accent' : 'bg-line'}`}
        >
          <span className={`block size-4 rounded-full bg-raised transition ${isRootless ? 'translate-x-4' : ''}`} />
        </button>
      </label>
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
