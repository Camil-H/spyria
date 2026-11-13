import type { MachineCountsRow, RuntimeHostRow } from '@spyria/db'
import { useQuery } from '@spyria/db/react'
import type { RuntimeHostId, WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  cardClass,
  Dialog,
  dangerButtonClass,
  ErrorMessage,
  fieldClass,
  LabelledSection,
  labelClass,
  RowMenu,
  rowClass,
  rowListClass,
  StatusBadge,
  type StatusTone,
  Switch,
  smallButtonClass,
  useGuardedAction,
} from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { isClaimExpired } from '../domain/claim.ts'
import { listRuntimeHosts, localSessionsOf, machineCountsOf } from '../queries/list-runtime-hosts.ts'
import { HostCommandDialog } from './HostCommandDialog.tsx'
import { HostVersion } from './HostVersion.tsx'
import { useRuntimeCommands } from './providers.tsx'

type OpenDialog =
  | { kind: 'add' }
  | { kind: 'command'; label: string; hostId: RuntimeHostId; code: string }
  | { kind: 'remove'; host: RuntimeHostRow }
  | null

const gibibyte = 1024 ** 3
const badgeClass = 'rounded-full border border-line px-2 py-0.5 text-xs text-muted'
const riskBadgeClass = 'rounded-full border border-callout-edge bg-callout px-2 py-0.5 text-xs text-ink'
const statusLabels = { waiting: 'Waiting for the host', online: 'Online', offline: 'Offline', expired: 'Code expired' }
const statusTones: Record<keyof typeof statusLabels, StatusTone> = {
  waiting: 'off',
  online: 'ok',
  offline: 'attention',
  expired: 'attention',
}
const machineUsageOf = ({ machines, claudeCode, codex }: Omit<MachineCountsRow, 'workspaceId'>) =>
  `${machines === 1 ? '1 member uses' : `${machines} members use`} their machine: ${claudeCode} signed in to Claude Code, ${codex} to Codex`

export const hostStatusOf = (host: RuntimeHostRow) =>
  host.status === 'waiting' && host.claimExpiresAt !== null && isClaimExpired(host.claimExpiresAt, Date.now())
    ? 'expired'
    : host.status

export const statusLabelOf = (host: RuntimeHostRow) => statusLabels[hostStatusOf(host)]

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

export const MemberLocalRuntimesSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useRuntimeCommands()
  const localSessions = useQuery(localSessionsOf, workspaceId)
  const machineCounts = useQuery(machineCountsOf, workspaceId)
  return (
    <LabelledSection title="Member local runtimes">
      <p className="-mt-2 text-sm text-muted">
        Members run Claude Code or Codex on their own computer, with their own subscription
      </p>
      <div className={rowListClass}>
        <div className={rowClass}>
          <Switch
            label="Members can run sessions on their own machine"
            isOn={localSessions}
            onToggle={() => commands.setLocalSessions({ workspaceId, isOn: !localSessions })}
          />
        </div>
        {machineCounts.machines > 0 && <p className={`${rowClass} text-muted`}>{machineUsageOf(machineCounts)}</p>}
      </div>
    </LabelledSection>
  )
}

const HostCapacity = ({ host }: { host: RuntimeHostRow }) => {
  if (!host.capacity) return null
  const usedShare = host.capacity.cap === 0 ? 0 : Math.min(1, host.runningRuntimes / host.capacity.cap)
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex items-center gap-2">
        <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-selected">
          <span className="block h-full bg-agent-done" style={{ width: `${usedShare * 100}%` }} />
        </span>
        <span>
          {host.runningRuntimes} / {host.capacity.cap} runtimes
        </span>
      </span>
      <span className="text-muted">
        <span>{host.capacity.cpus} CPUs</span> · <span>{(host.capacity.memoryBytes / gibibyte).toFixed(1)} GB</span>
      </span>
      <span
        className={host.capacity.rootless ? badgeClass : riskBadgeClass}
        title={
          host.capacity.rootless
            ? 'Docker runs without root on this host'
            : 'Docker on this host runs as root: containers are isolated but the daemon has root on the host'
        }
      >
        {host.capacity.rootless ? 'Rootless Docker' : 'Docker runs as root'}
      </span>
      {!host.capacity.limitsEnforced && <span className={riskBadgeClass}>Limits not enforced</span>}
    </span>
  )
}

export const RuntimeHostsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useRuntimeCommands()
  const hosts = useQuery(listRuntimeHosts, workspaceId)
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null)
  const closeDialog = () => setOpenDialog(null)
  const showCommand = (label: string, hostId: RuntimeHostId, code: string) =>
    setOpenDialog({ kind: 'command', label, hostId, code })
  return (
    <LabelledSection title="Runtime hosts">
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">The machines that run agent sessions in containers</p>
        <button type="button" className={buttonClass} onClick={() => setOpenDialog({ kind: 'add' })}>
          Add runtime host
        </button>
      </div>
      {hosts.length === 0 ? (
        <p className={`${cardClass} px-4 py-6 text-center text-sm text-muted`}>No runtime host yet</p>
      ) : (
        <ul aria-label="Hosts" className={rowListClass}>
          {hosts.map((host) => {
            const status = hostStatusOf(host)
            return (
              <li key={host.id} className="flex items-start gap-x-3 px-4 py-3 text-sm">
                <span className="flex w-48 shrink-0 flex-col gap-1">
                  <span className="truncate font-medium">{host.name}</span>
                  <StatusBadge tone={statusTones[status]}>{statusLabels[status]}</StatusBadge>
                </span>
                <span className="min-w-0 flex-1">
                  <HostCapacity host={host} />
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <HostVersion host={host} />
                  {status === 'expired' && (
                    <button
                      type="button"
                      className={smallButtonClass}
                      onClick={async () =>
                        showCommand('New command', host.id, await commands.renewCode({ workspaceId, hostId: host.id }))
                      }
                    >
                      New command
                    </button>
                  )}
                  <RowMenu
                    label={`Actions for ${host.name}`}
                    items={[{ label: 'Remove', onSelect: () => setOpenDialog({ kind: 'remove', host }) }]}
                  />
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {openDialog?.kind === 'add' && (
        <AddHostDialog
          add={async (name) => {
            const { id, code } = await commands.addHost({ workspaceId, name })
            showCommand('Add runtime host', id, code)
          }}
          onClose={closeDialog}
        />
      )}
      {openDialog?.kind === 'command' && (
        <HostCommandDialog
          label={openDialog.label}
          code={openDialog.code}
          isConnected={hosts.some((host) => host.id === openDialog.hostId && host.status === 'online')}
          onClose={closeDialog}
        />
      )}
      {openDialog?.kind === 'remove' && (
        <Dialog label="Remove runtime host" subject={openDialog.host.name} onClose={closeDialog}>
          <p className="text-sm text-muted">The host is disconnected and its token stops working.</p>
          <button
            type="button"
            className={dangerButtonClass}
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
