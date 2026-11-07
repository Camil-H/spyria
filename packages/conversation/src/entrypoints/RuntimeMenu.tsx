import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  focusRing,
  menuContentClass,
  menuItemClass,
  Spinner,
  useGuardedAction,
} from '@spyria/ui'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useAgentStream, useConversationCommands } from './providers.tsx'

type RuntimeAction = 'restartSession' | 'stopRuntime'
type RestartNotice = 'restarted' | 'startsOnNextMessage'
type Restart = 'restarting' | RestartNotice | null

const restartNotices: Record<RestartNotice, string> = {
  restarted: 'Session restarted',
  startsOnNextMessage: 'New session on your next message',
}

const actionLabels: Record<RuntimeAction, string> = {
  restartSession: 'Restart session',
  stopRuntime: 'Stop runtime',
}

const confirmations: Record<RuntimeAction, string> = {
  restartSession: 'The agent is working. Restarting the session stops this turn; the conversation is kept.',
  stopRuntime: 'The agent is working. Stopping the runtime stops this turn; your next message starts it again.',
}

const restartNoticeMilliseconds = 3_000
const restartGiveUpMilliseconds = 20_000

const useRestartFeedback = (workspaceId: WorkspaceId, chatId: ChatId) => {
  const agentStream = useAgentStream()
  const [restart, setRestart] = useState<Restart>(null)
  useEffect(() => {
    if (restart !== 'restarting') return
    const giveUp = setTimeout(() => setRestart(null), restartGiveUpMilliseconds)
    const unsubscribe = agentStream.subscribe(workspaceId, chatId, (frame) => {
      if ('sessionStarted' in frame) setRestart('restarted')
      if ('sessionStartsOnNextMessage' in frame) setRestart('startsOnNextMessage')
    })
    return () => {
      clearTimeout(giveUp)
      unsubscribe()
    }
  }, [agentStream, workspaceId, chatId, restart])
  useEffect(() => {
    if (restart === null || restart === 'restarting') return
    const hide = setTimeout(() => setRestart(null), restartNoticeMilliseconds)
    return () => clearTimeout(hide)
  }, [restart])
  return { restart, setRestart }
}

export const RuntimeMenu = ({
  workspaceId,
  chatId,
  isAgentWorking,
  children,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  isAgentWorking: boolean
  children: ReactNode
}) => {
  const commands = useConversationCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [confirming, setConfirming] = useState<RuntimeAction | null>(null)
  const { restart, setRestart } = useRestartFeedback(workspaceId, chatId)
  const act = async (action: RuntimeAction) => {
    if (action === 'restartSession') setRestart('restarting')
    const isDone = await run(() => commands[action]({ workspaceId, chatId }))
    if (!isDone && action === 'restartSession') setRestart(null)
  }
  const choose = (action: RuntimeAction) => (isAgentWorking ? setConfirming(action) : void act(action))
  return (
    <>
      <Root>
        <Trigger
          aria-label="Runtime actions"
          disabled={isPending || restart === 'restarting'}
          className={`flex items-center gap-1 rounded-md px-1 hover:bg-selected ${focusRing}`}
        >
          {restart === 'restarting' ? (
            <>
              <Spinner />
              Restarting…
            </>
          ) : restart ? (
            restartNotices[restart]
          ) : (
            children
          )}
          <ChevronDown aria-hidden className="size-3 text-muted" />
        </Trigger>
        <Content align="start" className={menuContentClass}>
          {(Object.keys(actionLabels) as RuntimeAction[]).map((action) => (
            <Item key={action} className={menuItemClass} onSelect={() => choose(action)}>
              {actionLabels[action]}
            </Item>
          ))}
        </Content>
      </Root>
      {errorMessage && <ErrorMessage message={errorMessage} />}
      {confirming && (
        <Dialog label={actionLabels[confirming]} onClose={() => setConfirming(null)}>
          <p className="text-sm text-muted">{confirmations[confirming]}</p>
          <button
            type="button"
            className={buttonClass}
            disabled={isPending}
            onClick={async () => {
              await act(confirming)
              setConfirming(null)
            }}
          >
            {actionLabels[confirming]}
          </button>
        </Dialog>
      )}
    </>
  )
}
