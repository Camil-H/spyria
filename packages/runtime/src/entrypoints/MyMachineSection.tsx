import type { RuntimeHostRow } from '@spyria/db'
import { useQuery } from '@spyria/db/react'
import {
  type HarnessId,
  harnesses,
  harnessIds,
  hostContainerOf,
  type MemberId,
  type RuntimeHostId,
  signInCommandOf,
  type WorkspaceId,
} from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  ghostButtonClass,
  rowClass,
  rowListClass,
  StatusBadge,
  smallButtonClass,
  smallGhostButtonClass,
  useGuardedAction,
} from '@spyria/ui'
import { useState } from 'react'
import { getMachine, localSessionsOf } from '../queries/list-runtime-hosts.ts'
import { CommandBox, HostCommand, HostCommandDialog, PersonalNotice, useCloseOnceDone } from './HostCommandDialog.tsx'
import { HostVersion } from './HostVersion.tsx'
import { useRuntimeCommands } from './providers.tsx'
import { hostStatusOf, statusLabelOf } from './RuntimeHostsSection.tsx'

const StartMachine = ({
  workspaceId,
  hostId,
  signIn,
}: {
  workspaceId: WorkspaceId
  hostId: RuntimeHostId
  signIn?: HarnessId
}) => {
  const commands = useRuntimeCommands()
  const { deployment } = useSession()
  const [code, setCode] = useState<string | null>(null)
  const { errorMessage, isPending, run } = useGuardedAction()
  return (
    <>
      <p className="text-sm text-muted">Start Docker on your computer, then run:</p>
      <CommandBox command={`docker start ${hostContainerOf(deployment)}`} />
      <p className="text-sm text-muted">
        If it stays offline, set it up again. Its old connection stops working; your sign-ins are kept.
      </p>
      {code ? (
        <HostCommand code={code} personal signIn={signIn} />
      ) : (
        <button
          type="button"
          className={ghostButtonClass}
          disabled={isPending}
          onClick={() => run(async () => setCode(await commands.renewCode({ workspaceId, hostId })))}
        >
          Set up again
        </button>
      )}
      <ErrorMessage message={errorMessage} />
    </>
  )
}

const StartMachineDialog = ({
  workspaceId,
  machine,
  onClose,
}: {
  workspaceId: WorkspaceId
  machine: RuntimeHostRow
  onClose: () => void
}) => {
  useCloseOnceDone(machine.status === 'online', onClose)
  return (
    <Dialog label="Start my machine" closeLabel="Close" onClose={onClose}>
      <p className="text-sm">Your machine: {statusLabelOf(machine)}</p>
      <StartMachine workspaceId={workspaceId} hostId={machine.id} />
    </Dialog>
  )
}

const UseToolDialog = ({
  workspaceId,
  machine,
  tool,
  code,
  onClose,
}: {
  workspaceId: WorkspaceId
  machine: RuntimeHostRow | undefined
  tool: HarnessId
  code: string | null
  onClose: () => void
}) => {
  const { deployment } = useSession()
  const toolName = harnesses[tool].name
  const isOnline = machine?.status === 'online'
  const isSignedIn = isOnline && machine.capacity?.signedIn?.includes(tool) === true
  useCloseOnceDone(isSignedIn, onClose)
  return (
    <Dialog label={`Use ${toolName}`} closeLabel="Close" onClose={onClose}>
      {machine && <p className="text-sm">Your machine: {statusLabelOf(machine)}</p>}
      {isOnline ? (
        isSignedIn ? (
          <p className="text-sm">
            {toolName} is ready: in a new Runtime chat, set Runs on to Local · {toolName}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">Sign in to {toolName} on your machine:</p>
            <CommandBox command={signInCommandOf(tool, deployment)} />
          </>
        )
      ) : code ? (
        <>
          <PersonalNotice toolName={toolName} />
          <HostCommand code={code} personal signIn={tool} />
        </>
      ) : (
        machine && <StartMachine workspaceId={workspaceId} hostId={machine.id} signIn={tool} />
      )}
    </Dialog>
  )
}

const machineToneOf = (machine: RuntimeHostRow) => {
  const status = hostStatusOf(machine)
  return status === 'online' ? 'ok' : status === 'offline' ? 'off' : 'attention'
}

export const MyMachineSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useRuntimeCommands()
  const machine = useQuery(getMachine, workspaceId, memberId)
  const localSessions = useQuery(localSessionsOf, workspaceId)
  const [code, setCode] = useState<string | null>(null)
  const [openDialog, setOpenDialog] = useState<'add' | 'start' | 'remove' | HarnessId | null>(null)
  const isOnline = machine?.status === 'online'
  const isSignedIn = (tool: HarnessId) => isOnline && machine.capacity?.signedIn?.includes(tool) === true
  const connectedTools = harnessIds.filter(isSignedIn)
  const open = async (dialog: 'add' | HarnessId) => {
    setOpenDialog(dialog)
    if (!machine) setCode((await commands.addMachine({ workspaceId })).code)
  }
  const connectingTool = openDialog === 'add' || openDialog === 'start' || openDialog === 'remove' ? null : openDialog
  return (
    <section aria-label="My machine" className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Run Claude Code and Codex on your own computer, signed in with your own subscription.
      </p>
      {(machine || localSessions) && (
        <ul aria-label="Machine and tools" className={rowListClass}>
          <li aria-label={machine ? machine.name : 'No machine'} className={rowClass}>
            {machine ? (
              <>
                <span className="w-40 truncate font-medium">{machine.name}</span>
                <StatusBadge tone={machineToneOf(machine)}>{statusLabelOf(machine)}</StatusBadge>
                <HostVersion host={machine} />
                <span className="ml-auto flex gap-2">
                  {!isOnline && (
                    <button type="button" className={smallButtonClass} onClick={() => setOpenDialog('start')}>
                      Start
                    </button>
                  )}
                  <button type="button" className={smallGhostButtonClass} onClick={() => setOpenDialog('remove')}>
                    Remove
                  </button>
                </span>
              </>
            ) : (
              <>
                <span className="text-muted">No machine added yet</span>
                <button type="button" className={`ml-auto ${smallButtonClass}`} onClick={() => open('add')}>
                  Add my machine
                </button>
              </>
            )}
          </li>
          {localSessions &&
            harnessIds.map((tool) => {
              const toolName = harnesses[tool].name
              return (
                <li key={tool} aria-label={toolName} className={rowClass}>
                  <span className="w-40 truncate font-medium">{toolName}</span>
                  {isSignedIn(tool) ? (
                    <StatusBadge tone="ok">Signed in</StatusBadge>
                  ) : (
                    <>
                      <StatusBadge tone="off">Not signed in</StatusBadge>
                      <button
                        type="button"
                        aria-label={`Set up ${toolName}`}
                        className={`ml-auto ${smallGhostButtonClass}`}
                        onClick={() => open(tool)}
                      >
                        Set up
                      </button>
                    </>
                  )}
                </li>
              )
            })}
        </ul>
      )}
      {!localSessions && <p className="text-sm text-muted">Your workspace turned off sessions on members' machines</p>}
      {localSessions && connectedTools.length > 0 && (
        <p className="text-sm text-muted">
          In a new Runtime chat, set Runs on to{' '}
          {connectedTools.map((tool) => `Local · ${harnesses[tool].name}`).join(' or ')}
        </p>
      )}
      {openDialog === 'add' && code && (
        <HostCommandDialog
          label="Add my machine"
          code={code}
          personal
          isConnected={isOnline}
          onClose={() => setOpenDialog(null)}
        />
      )}
      {connectingTool && (
        <UseToolDialog
          workspaceId={workspaceId}
          machine={machine}
          tool={connectingTool}
          code={code}
          onClose={() => setOpenDialog(null)}
        />
      )}
      {openDialog === 'start' && machine && (
        <StartMachineDialog workspaceId={workspaceId} machine={machine} onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === 'remove' && machine && (
        <Dialog label="Remove my machine" onClose={() => setOpenDialog(null)}>
          <p className="text-sm text-muted">The machine is disconnected and its token stops working.</p>
          <button
            type="button"
            className={buttonClass}
            onClick={async () => {
              await commands.removeHost({ workspaceId, hostId: machine.id })
              setOpenDialog(null)
            }}
          >
            Remove
          </button>
        </Dialog>
      )}
    </section>
  )
}
