import type { RuntimeHostRow } from '@spyria/db'
import { useSession } from '@spyria/session'
import { Dialog } from '@spyria/ui'
import { useState } from 'react'
import { hostCommandOf } from '../domain/host-command.ts'
import { hostUpdateOf } from '../domain/host-version.ts'
import { CommandBox } from './HostCommandDialog.tsx'

const updateLabels = { needed: 'Update needed', available: 'Update available' }
const badgeClass = 'rounded-full border border-line px-2 py-0.5 text-xs'

export const HostVersion = ({
  host,
}: {
  host: Pick<RuntimeHostRow, 'status' | 'hostVersion' | 'protocolVersion' | 'ownerId'>
}) => {
  const { deployment, version, hostImage } = useSession()
  const [isDialogOpen, setDialogOpen] = useState(false)
  const update = hostUpdateOf(host, version)
  if (host.hostVersion === null && !update) return null
  const label = update && updateLabels[update]
  return (
    <>
      {host.hostVersion !== null && <span className="text-muted">{host.hostVersion}</span>}
      {label && (
        <button
          type="button"
          className={`${badgeClass} ${update === 'needed' ? 'font-medium text-ink' : 'text-muted'}`}
          onClick={() => setDialogOpen(true)}
        >
          {label}
        </button>
      )}
      {label && isDialogOpen && (
        <Dialog label={label} closeLabel="Close" onClose={() => setDialogOpen(false)}>
          <p className="text-sm text-muted">
            {update === 'needed'
              ? 'This host is too old for this Spyria and is refused until it is updated. Run this on that machine; its sign-ins and token are kept:'
              : `This host runs ${host.hostVersion} and Spyria is ${version}. To update it, run this on that machine; its sign-ins and token are kept:`}
          </p>
          <CommandBox
            command={hostCommandOf({
              deployment,
              origin: location.origin,
              image: hostImage,
              personal: host.ownerId !== null,
              update: true,
            })}
          />
        </Dialog>
      )}
    </>
  )
}
