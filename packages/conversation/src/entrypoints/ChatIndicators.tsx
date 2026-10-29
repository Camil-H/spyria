import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { useDraftQuery, useQuery } from '@spyria/db/react'
import { type ChatId, workspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { tooltipClass } from '@spyria/ui'
import {
  Check,
  CircleAlert,
  CircleQuestionMark,
  CircleX,
  createLucideIcon,
  Hourglass,
  type LucideIcon,
  Pencil,
} from 'lucide-react'
import { useParams } from 'react-router'
import { type AgentStatus, agentStatusLabels } from '../domain/agent-status.ts'
import { getAgentStatus } from '../queries/get-agent-status.ts'
import { getDraft } from '../queries/get-draft.ts'
import { hasUnread } from '../queries/has-unread.ts'

const Zzz = createLucideIcon('zzz', [
  ['path', { d: 'M3 13h7l-7 8h7', key: 'large' }],
  ['path', { d: 'M14 4h6l-6 7h6', key: 'small' }],
])

const statusIcons: Record<AgentStatus, { Icon: LucideIcon; color: string }> = {
  working: { Icon: Hourglass, color: 'text-agent-working' },
  waiting: { Icon: CircleQuestionMark, color: 'text-agent-waiting' },
  error: { Icon: CircleX, color: 'text-agent-error' },
  sleeping: { Icon: Zzz, color: 'text-muted' },
  done: { Icon: Check, color: 'text-agent-done' },
}
const plainUnreadIcon = { Icon: CircleAlert, color: 'text-ink' }

export const ChatIndicators = ({ chatId }: { chatId: ChatId }) => {
  const { memberId } = useSession()
  const chatWorkspaceId = workspaceId(useParams().workspaceId ?? '')
  const isUnread = useQuery(hasUnread, chatWorkspaceId, chatId, memberId)
  const isDraftPresent = useDraftQuery(getDraft, chatWorkspaceId, chatId, memberId) !== ''
  const agentStatus = useQuery(getAgentStatus, chatWorkspaceId, chatId)
  const unreadLabel = agentStatus ? `Unread messages · ${agentStatusLabels[agentStatus]}` : 'Unread messages'
  const { Icon, color } = agentStatus ? statusIcons[agentStatus] : plainUnreadIcon
  return (
    <>
      {isUnread && (
        <Provider>
          <Root>
            <Trigger asChild>
              <Icon role="img" aria-label={unreadLabel} size={14} className={`shrink-0 ${color}`} />
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
