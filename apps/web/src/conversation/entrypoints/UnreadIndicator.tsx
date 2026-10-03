import { useQuery } from '@hq/db'
import { type ChatId, workspaceId } from '@hq/kernel'
import { tooltipClass } from '@hq/ui'
import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { CircleAlert } from 'lucide-react'
import { useParams } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { hasUnread } from '../queries/has-unread.ts'

export const UnreadIndicator = ({ chatId }: { chatId: ChatId }) => {
  const { memberId } = useSession()
  const isUnreadPresent = useQuery(hasUnread(workspaceId(useParams().workspaceId ?? ''), chatId, memberId))
  return isUnreadPresent ? (
    <Provider>
      <Root>
        <Trigger asChild>
          <CircleAlert role="img" aria-label="Unread messages" size={14} className="shrink-0 text-ink" />
        </Trigger>
        <Portal>
          <Content sideOffset={6} className={tooltipClass}>
            Unread messages
          </Content>
        </Portal>
      </Root>
    </Provider>
  ) : null
}
