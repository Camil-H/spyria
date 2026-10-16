import { useQuery } from '@hq/db/react'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, ghostButtonClass, LabelledSection } from '@hq/ui'
import { useEffect, useState } from 'react'
import { type SignInTool, signInCommandOf } from '../domain/host-command.ts'
import { getMachine, localSessionsOf } from '../queries/list-runtime-hosts.ts'
import { CommandBox, HostCommand, HostCommandDialog, PersonalNotice } from './HostCommandDialog.tsx'
import { useRuntimeCommands } from './providers.tsx'
import { statusLabelOf } from './RuntimeHostsSection.tsx'

const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-1'
const toolNames: Record<SignInTool, string> = { claude: 'Claude Code', codex: 'Codex' }
const myMachineAnchor = 'my-machine'

export const MyMachineSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useRuntimeCommands()
  const machine = useQuery(getMachine(workspaceId, memberId))
  const localSessions = useQuery(localSessionsOf(workspaceId))
  const [code, setCode] = useState<string | null>(null)
  const [openDialog, setOpenDialog] = useState<'add' | 'remove' | SignInTool | null>(null)
  useEffect(() => {
    if (location.hash === `#${myMachineAnchor}`) document.getElementById(myMachineAnchor)?.scrollIntoView()
  }, [])
  const isOnline = machine?.status === 'online'
  const open = async (dialog: 'add' | SignInTool) => {
    setOpenDialog(dialog)
    if (!machine) setCode((await commands.addMachine({ workspaceId })).code)
  }
  const connectingTool = openDialog === 'add' || openDialog === 'remove' ? null : openDialog
  return (
    <LabelledSection title="My machine" id={myMachineAnchor}>
      {machine ? (
        <div className={`${rowClass} text-sm`}>
          <span className="font-medium">{machine.name}</span>
          <span className="text-muted">{statusLabelOf(machine)}</span>
          <button type="button" className={`ml-auto ${ghostButtonClass}`} onClick={() => setOpenDialog('remove')}>
            Remove
          </button>
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
          {(Object.keys(toolNames) as SignInTool[]).map((tool) => {
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
                {isConnected ? `✓ ${toolNames[tool]} connected` : `Use ${toolNames[tool]}`}
              </button>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">Your workspace turned off sessions on members' machines</p>
      )}
      {openDialog === 'add' && code && (
        <HostCommandDialog label="Add my machine" code={code} personal onClose={() => setOpenDialog(null)} />
      )}
      {connectingTool && (
        <Dialog label={`Use ${toolNames[connectingTool]}`} closeLabel="Close" onClose={() => setOpenDialog(null)}>
          {machine && <p className="text-sm">Your machine: {statusLabelOf(machine)}</p>}
          {isOnline ? (
            machine.capacity?.signedIn?.includes(connectingTool) ? (
              <p className="text-sm">
                {toolNames[connectingTool]} is ready: in a new Runtime chat, set Runs on to Local ·{' '}
                {toolNames[connectingTool]}
              </p>
            ) : (
              <>
                <p className="text-sm text-muted">Sign in to {toolNames[connectingTool]} on your machine:</p>
                <CommandBox command={signInCommandOf(connectingTool)} />
              </>
            )
          ) : (
            code && (
              <>
                <PersonalNotice toolName={toolNames[connectingTool]} />
                <HostCommand code={code} personal signIn={connectingTool} />
              </>
            )
          )}
        </Dialog>
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
