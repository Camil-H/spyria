import { useQuery } from '@hq/db/react'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, ghostButtonClass, LabelledSection } from '@hq/ui'
import { useState } from 'react'
import { getMachine, localSessionsOf } from '../queries/list-runtime-hosts.ts'
import { HostCommandDialog } from './HostCommandDialog.tsx'
import { useRuntimeCommands } from './providers.tsx'
import { statusLabelOf } from './RuntimeHostsSection.tsx'

const signIns = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
]

export const MyMachineSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useRuntimeCommands()
  const machine = useQuery(getMachine(workspaceId, memberId))
  const localSessions = useQuery(localSessionsOf(workspaceId))
  const [code, setCode] = useState<string | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  return (
    <LabelledSection title="My machine">
      {machine ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">{machine.name}</span>
          <span className="text-muted">{statusLabelOf(machine)}</span>
          {machine.status === 'online' &&
            signIns.map(({ id, name }) => (
              <span key={id}>
                {machine.capacity?.signedIn?.includes(id)
                  ? `Signed in to ${name}`
                  : `Not signed in to ${name}: docker exec -it hq-host hq-host login ${id}`}
              </span>
            ))}
          <button type="button" className={`ml-auto ${ghostButtonClass}`} onClick={() => setIsRemoving(true)}>
            Remove
          </button>
        </div>
      ) : localSessions ? (
        <button
          type="button"
          className={`self-start ${buttonClass}`}
          onClick={async () => setCode((await commands.addMachine({ workspaceId })).code)}
        >
          Add my machine
        </button>
      ) : (
        <p className="text-sm text-muted">Your workspace turned off sessions on members' machines</p>
      )}
      {code && <HostCommandDialog label="Add my machine" code={code} personal onClose={() => setCode(null)} />}
      {isRemoving && machine && (
        <Dialog label="Remove my machine" onClose={() => setIsRemoving(false)}>
          <p className="text-sm text-muted">The machine is disconnected and its token stops working.</p>
          <button
            type="button"
            className={buttonClass}
            onClick={async () => {
              await commands.removeHost({ workspaceId, hostId: machine.id })
              setIsRemoving(false)
            }}
          >
            Remove
          </button>
        </Dialog>
      )}
    </LabelledSection>
  )
}
