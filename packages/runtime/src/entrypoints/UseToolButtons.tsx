import { useQuery } from '@hq/db/react'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog } from '@hq/ui'
import { useState } from 'react'
import { type SignInTool, signInCommandOf } from '../domain/host-command.ts'
import { getMachine, localSessionsOf } from '../queries/list-runtime-hosts.ts'
import { CommandBox, HostCommand, PersonalNotice } from './HostCommandDialog.tsx'
import { useRuntimeCommands } from './providers.tsx'
import { statusLabelOf } from './RuntimeHostsSection.tsx'

const tools: Record<SignInTool, { name: string }> = { claude: { name: 'Claude Code' }, codex: { name: 'Codex' } }

export const UseToolButtons = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useRuntimeCommands()
  const machine = useQuery(getMachine(workspaceId, memberId))
  const localSessions = useQuery(localSessionsOf(workspaceId))
  const [openTool, setOpenTool] = useState<SignInTool | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const open = async (tool: SignInTool) => {
    setOpenTool(tool)
    if (!machine && localSessions) setCode((await commands.addMachine({ workspaceId })).code)
  }
  return (
    <div className="flex gap-2">
      {(Object.keys(tools) as SignInTool[]).map((tool) => (
        <button key={tool} type="button" className={buttonClass} onClick={() => open(tool)}>
          Use {tools[tool].name}
        </button>
      ))}
      {openTool && (
        <Dialog label={`Use ${tools[openTool].name}`} closeLabel="Close" onClose={() => setOpenTool(null)}>
          {!localSessions ? (
            <p className="text-sm text-muted">Your workspace turned off sessions on members' machines</p>
          ) : (
            <>
              {machine && <p className="text-sm">Your machine: {statusLabelOf(machine)}</p>}
              {machine?.status === 'online' ? (
                machine.capacity?.signedIn?.includes(openTool) ? (
                  <p className="text-sm">
                    {tools[openTool].name} is ready: in a new Runtime chat, set Runs on to My machine ·{' '}
                    {tools[openTool].name}
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-muted">Sign in to {tools[openTool].name} on your machine:</p>
                    <CommandBox command={signInCommandOf(openTool)} />
                  </>
                )
              ) : (
                code && (
                  <>
                    <PersonalNotice toolName={tools[openTool].name} />
                    <HostCommand code={code} personal signIn={openTool} />
                  </>
                )
              )}
            </>
          )}
        </Dialog>
      )}
    </div>
  )
}
