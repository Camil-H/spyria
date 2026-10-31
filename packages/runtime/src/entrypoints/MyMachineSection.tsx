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
import { buttonClass, Dialog, ErrorMessage, ghostButtonClass, LabelledSection, useGuardedAction } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { getMachine, localSessionsOf } from '../queries/list-runtime-hosts.ts'
import { CommandBox, HostCommand, HostCommandDialog, PersonalNotice, useCloseOnceDone } from './HostCommandDialog.tsx'
import { useRuntimeCommands } from './providers.tsx'
import { statusLabelOf } from './RuntimeHostsSection.tsx'

const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-1'
const myMachineAnchor = 'my-machine'

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

export const MyMachineSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useRuntimeCommands()
  const machine = useQuery(getMachine, workspaceId, memberId)
  const localSessions = useQuery(localSessionsOf, workspaceId)
  const [code, setCode] = useState<string | null>(null)
  const [openDialog, setOpenDialog] = useState<'add' | 'start' | 'remove' | HarnessId | null>(null)
  useEffect(() => {
    if (location.hash === `#${myMachineAnchor}`) document.getElementById(myMachineAnchor)?.scrollIntoView()
  }, [])
  const isOnline = machine?.status === 'online'
  const connectedTools = isOnline ? harnessIds.filter((tool) => machine.capacity?.signedIn?.includes(tool)) : []
  const open = async (dialog: 'add' | HarnessId) => {
    setOpenDialog(dialog)
    if (!machine) setCode((await commands.addMachine({ workspaceId })).code)
  }
  const connectingTool = openDialog === 'add' || openDialog === 'start' || openDialog === 'remove' ? null : openDialog
  return (
    <LabelledSection title="My machine" id={myMachineAnchor}>
      {machine ? (
        <div className={`${rowClass} text-sm`}>
          <span className="font-medium">{machine.name}</span>
          <span className="text-muted">{statusLabelOf(machine)}</span>
          <span className="ml-auto flex gap-2">
            {!isOnline && (
              <button type="button" className={buttonClass} onClick={() => setOpenDialog('start')}>
                Start
              </button>
            )}
            <button type="button" className={ghostButtonClass} onClick={() => setOpenDialog('remove')}>
              Remove
            </button>
          </span>
        </div>
      ) : (
        localSessions && (
          <button type="button" className={`self-start ${buttonClass}`} onClick={() => open('add')}>
            Add my machine
          </button>
        )
      )}
      {localSessions ? (
        <div className="flex flex-wrap gap-2">
          {harnessIds.map((tool) => {
            const isConnected = isOnline && machine.capacity?.signedIn?.includes(tool)
            return (
              <button
                key={tool}
                type="button"
                className={
                  isConnected
                    ? `${ghostButtonClass} border-(--c) text-(--c)! [--c:light-dark(var(--color-green-900),var(--color-green-400))]`
                    : buttonClass
                }
                onClick={() => open(tool)}
              >
                {isConnected ? `✓ ${harnesses[tool].name} connected` : `Use ${harnesses[tool].name}`}
              </button>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">Your workspace turned off sessions on members' machines</p>
      )}
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
    </LabelledSection>
  )
}
