import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { useQuery } from '@spyria/db/react'
import { type ChatId, workspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { tooltipClass } from '@spyria/ui'
import { CircleAlert, Pencil } from 'lucide-react'
import { useParams } from 'react-router'
import { getDraft } from '../queries/get-draft.ts'
import { hasUnread } from '../queries/has-unread.ts'

export const ChatIndicators = ({ chatId }: { chatId: ChatId }) => {
  const { memberId } = useSession()
  const chatWorkspaceId = workspaceId(useParams().workspaceId ?? '')
  const isUnread = useQuery(hasUnread(chatWorkspaceId, chatId, memberId))
  const isDraftPresent = useQuery(getDraft(chatWorkspaceId, chatId, memberId)) !== ''
  return (
    <>
      {isUnread && (
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
      )}
      {isDraftPresent && <Pencil role="img" aria-label="Has unsent draft" size={12} className="shrink-0 text-muted" />}
    </>
  )
}
