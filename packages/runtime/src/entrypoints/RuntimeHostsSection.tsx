import type { RuntimeHostRow } from '@spyria/db'
import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  Switch,
  useGuardedAction,
} from '@spyria/ui'
import { type SubmitEvent, useEffect, useState } from 'react'
import { isClaimExpired } from '../domain/claim.ts'
import { listRuntimeHosts, localSessionsOf } from '../queries/list-runtime-hosts.ts'
import { HostCommandDialog } from './HostCommandDialog.tsx'
import { useRuntimeCommands } from './providers.tsx'

type OpenDialog =
  | { kind: 'add' }
  | { kind: 'command'; label: string; code: string }
  | { kind: 'remove'; host: RuntimeHostRow }
  | null

const gibibyte = 1024 ** 3
const badgeClass = 'rounded-full border border-line px-2 py-0.5 text-xs text-muted'
const statusLabels = { waiting: 'Waiting for the host', online: 'Online', offline: 'Offline', expired: 'Code expired' }

export const statusOf = (host: RuntimeHostRow) =>
  host.status === 'waiting' && host.claimExpiresAt !== null && isClaimExpired(host.claimExpiresAt, Date.now())
    ? 'expired'
    : host.status

export const statusLabelOf = (host: RuntimeHostRow) => statusLabels[statusOf(host)]

const AddHostDialog = ({ add, onClose }: { add: (name: string) => Promise<void>; onClose: () => void }) => {
  const [name, setName] = useState('')
  const { errorMessage, run } = useGuardedAction()
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    await run(() => add(name))
  }
  return (
    <Dialog label="Add runtime host" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={labelClass}>
          Host name
          <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <ErrorMessage message={errorMessage} />
        <button type="submit" className={buttonClass} disabled={name.trim() === ''}>
          Add
        </button>
      </form>
    </Dialog>
  )
}

export const RuntimeHostsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useRuntimeCommands()
  const hosts = useQuery(listRuntimeHosts, workspaceId)
  const localSessions = useQuery(localSessionsOf, workspaceId)
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null)
  const [machineCount, setMachineCount] = useState(0)
  useEffect(() => {
    commands.countMachines({ workspaceId }).then(setMachineCount)
  }, [commands, workspaceId])
  const closeDialog = () => setOpenDialog(null)
  const showCommand = (label: string, code: string) => setOpenDialog({ kind: 'command', label, code })
  return (
    <LabelledSection title="Runtime hosts">
      <button type="button" className={`self-start ${buttonClass}`} onClick={() => setOpenDialog({ kind: 'add' })}>
        Add runtime host
      </button>
      {hosts.length === 0 ? (
        <p className="text-sm text-muted">No runtime host yet</p>
      ) : (
        <ul aria-label="Hosts" className="flex flex-col gap-2 text-sm">
          {hosts.map((host) => {
            const status = statusOf(host)
            return (
              <li key={host.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{host.name}</span>
                <span className="text-muted">{statusLabels[status]}</span>
                {host.capacity && (
                  <>
                    <span>{host.capacity.cpus} CPUs</span>
                    <span>{(host.capacity.memoryBytes / gibibyte).toFixed(1)} GB</span>
                    <span>
                      {host.runningRuntimes} / {host.capacity.cap} runtimes
                    </span>
                    <span
                      className={badgeClass}
                      title={
                        host.capacity.rootless
                          ? 'Docker runs without root on this host'
                          : 'Docker on this host runs as root: containers are isolated but the daemon has root on the host'
                      }
                    >
                      {host.capacity.rootless ? 'Docker: rootless' : 'Docker: root'}
                    </span>
                    {!host.capacity.limitsEnforced && <span className={badgeClass}>Limits not enforced</span>}
                  </>
                )}
                <span className="ml-auto flex gap-2">
                  {status === 'expired' && (
                    <button
                      type="button"
                      className={ghostButtonClass}
                      onClick={async () =>
                        showCommand('New command', await commands.renewCode({ workspaceId, hostId: host.id }))
                      }
                    >
                      New command
                    </button>
                  )}
                  <button
                    type="button"
                    className={ghostButtonClass}
                    onClick={() => setOpenDialog({ kind: 'remove', host })}
                  >
                    Remove
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {machineCount > 0 && (
        <p className="text-sm text-muted">
          {machineCount === 1 ? '1 member uses their machine' : `${machineCount} members use their machine`}
        </p>
      )}
      <Switch
        label="Members can run sessions on their own machine"
        isOn={localSessions}
        onToggle={() => commands.setLocalSessions({ workspaceId, isOn: !localSessions })}
      />
      {openDialog?.kind === 'add' && (
        <AddHostDialog
          add={async (name) => showCommand('Add runtime host', (await commands.addHost({ workspaceId, name })).code)}
          onClose={closeDialog}
        />
      )}
      {openDialog?.kind === 'command' && (
        <HostCommandDialog label={openDialog.label} code={openDialog.code} onClose={closeDialog} />
      )}
      {openDialog?.kind === 'remove' && (
        <Dialog label="Remove runtime host" subject={openDialog.host.name} onClose={closeDialog}>
          <p className="text-sm text-muted">The host is disconnected and its token stops working.</p>
          <button
            type="button"
            className={buttonClass}
            onClick={async () => {
              await commands.removeHost({ workspaceId, hostId: openDialog.host.id })
              closeDialog()
            }}
          >
            Remove
          </button>
        </Dialog>
      )}
    </LabelledSection>
  )
}
