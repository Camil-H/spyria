import { useQuery } from '@hq/db/react'
import { useEffect, useState } from 'react'
import { getTerminal } from '../queries/get-terminal.ts'
import { usePanelCommands } from './providers.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { WorkspaceStatus } from './WorkspaceStatus.tsx'

const TerminalTab = ({ workspaceId, chatId }: TabProps) => {
  const commands = useQuery(getTerminal(workspaceId, chatId))
  const { watchCommandOutput } = usePanelCommands()
  const [liveOutputs, setLiveOutputs] = useState<Readonly<Record<string, string>>>({})
  useEffect(
    () =>
      watchCommandOutput(workspaceId, chatId, ({ stepId, output }) =>
        setLiveOutputs((current) => ({ ...current, [stepId]: output })),
      ),
    [watchCommandOutput, workspaceId, chatId],
  )
  return (
    <>
      <WorkspaceStatus workspaceId={workspaceId} chatId={chatId} />
      {commands.length === 0 ? (
        <p className={emptyClass}>No terminal output</p>
      ) : (
        <section
          aria-label="Terminal output"
          className="flex flex-col gap-3 overflow-x-auto rounded-md border border-line bg-app p-3 font-mono text-xs"
        >
          {commands.map(({ stepId, command, output, exitCode, isRunning }) => (
            <div key={stepId} className="flex flex-col gap-1">
              <span className="font-semibold text-ink">$ {command}</span>
              <pre className="whitespace-pre-wrap text-muted">
                {exitCode === null ? (liveOutputs[stepId] ?? output) : output}
              </pre>
              <span className="text-muted">
                {exitCode !== null ? `exit ${exitCode}` : isRunning ? 'running…' : 'stopped'}
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

export default TerminalTab
