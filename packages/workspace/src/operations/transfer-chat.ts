import { type ChatId, type MemberId, requireWorkspacePermission } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { ChatOwnerActive } from '../domain/errors.ts'
import { isActive, requireActiveMember } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { chatId: ChatId; ownerId: MemberId; actorId: MemberId }

export const transferChat = ({ transactor }: Dependencies, { chatId, ownerId, actorId }: Input) =>
  transactor.run(async ({ memberships, chats, workspaceEvents }) => {
    await requireWorkspacePermission(memberships, actorId, 'members.manage')
    const chat = await chats.get(chatId)
    if (isActive(await memberships.get(chat.ownerId))) throw new ChatOwnerActive()
    requireActiveMember(await memberships.get(ownerId), ownerId)
    await chats.transfer({ chat, ownerId, actorId })
    await workspaceEvents.record({
      type: 'chat.transferred',
      actorId,
      payload: { chatId, fromId: chat.ownerId, toId: ownerId },
    })
  })
