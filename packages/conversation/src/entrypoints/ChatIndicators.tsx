import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { useDraftQuery, useQuery } from '@spyria/db/react'
import { type ChatId, workspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { tooltipClass } from '@spyria/ui'
import { CircleAlert, Pencil } from 'lucide-react'
import { useParams } from 'react-router'
import { type AgentStatus, agentStatusLabels } from '../domain/agent-status.ts'
import { getAgentStatus } from '../queries/get-agent-status.ts'
import { getDraft } from '../queries/get-draft.ts'
import { hasUnread } from '../queries/has-unread.ts'

const unreadColors: Record<AgentStatus, string> = {
  working: 'text-agent-working',
  waiting: 'text-agent-waiting',
  error: 'text-agent-error',
  done: 'text-agent-done',
}

export const ChatIndicators = ({ chatId }: { chatId: ChatId }) => {
  const { memberId } = useSession()
  const chatWorkspaceId = workspaceId(useParams().workspaceId ?? '')
  const isUnread = useQuery(hasUnread, chatWorkspaceId, chatId, memberId)
  const isDraftPresent = useDraftQuery(getDraft, chatWorkspaceId, chatId, memberId) !== ''
  const agentStatus = useQuery(getAgentStatus, chatWorkspaceId, chatId)
  const unreadLabel = agentStatus ? `Unread messages · ${agentStatusLabels[agentStatus]}` : 'Unread messages'
  return (
    <>
      {isUnread && (
        <Provider>
          <Root>
            <Trigger asChild>
              <CircleAlert
                role="img"
                aria-label={unreadLabel}
                size={14}
                className={`shrink-0 ${agentStatus ? unreadColors[agentStatus] : 'text-ink'}`}
              />
            </Trigger>
            <Portal>
              <Content sideOffset={6} className={tooltipClass}>
                {unreadLabel}
              </Content>
            </Portal>
          </Root>
        </Provider>
      )}
      {isDraftPresent && <Pencil role="img" aria-label="Has unsent draft" size={12} className="shrink-0 text-muted" />}
    </>
  )
}
