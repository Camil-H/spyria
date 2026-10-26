import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  focusRing,
  menuContentClass,
  menuItemClass,
  useGuardedAction,
} from '@spyria/ui'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useConversationCommands } from './providers.tsx'

type RuntimeAction = 'restartSession' | 'stopRuntime'

const actionLabels: Record<RuntimeAction, string> = {
  restartSession: 'Restart session',
  stopRuntime: 'Stop runtime',
}

const confirmations: Record<RuntimeAction, string> = {
  restartSession: 'The agent is working. Restarting the session stops this turn; the conversation is kept.',
  stopRuntime: 'The agent is working. Stopping the runtime stops this turn; your next message starts it again.',
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
  const act = (action: RuntimeAction) => run(() => commands[action]({ workspaceId, chatId }))
  const choose = (action: RuntimeAction) => (isAgentWorking ? setConfirming(action) : void act(action))
  return (
    <>
      <Root>
        <Trigger
          aria-label="Runtime actions"
          disabled={isPending}
          className={`flex items-center gap-1 rounded-md px-1 hover:bg-selected ${focusRing}`}
        >
          {children}
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
