import type { ZeroContext } from '@hq/db/zero-queries'
import { chatId, messageId } from '@hq/kernel'
import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import { z } from 'zod'
import { ForeignWorkspace } from '../domain/errors.ts'
import { createSystemClock } from '../integrations/system-clock.ts'
import { createZeroRuntimeChatStarter } from '../integrations/workspace-runtime-chat-starter.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { deleteMessage } from '../operations/delete-message.ts'
import { editMessage } from '../operations/edit-message.ts'
import { markChatRead } from '../operations/mark-chat-read.ts'
import { sendMessage } from '../operations/send-message.ts'
import { startRuntimeFromMessage } from '../operations/start-runtime-from-message.ts'

const id = z.string().min(1)
const chatIdArgument = id.transform(chatId)
const messageIdArgument = id.transform(messageId)

const workspaceArguments = z.object({ workspaceId: id })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string; id?: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new ForeignWorkspace()
  return {
    transactor: createZeroTransactor(tx, context.workspaceId),
    idGenerator: { next: () => args.id ?? '' },
    clock: createSystemClock(),
  }
}

export const conversationMutators = defineMutators({
  conversation: {
    sendMessage: defineMutator(
      workspaceArguments.extend({ id, chatId: chatIdArgument, text: z.string() }),
      ({ tx, ctx, args }) =>
        sendMessage(dependenciesOf(tx, ctx, args), { chatId: args.chatId, authorId: ctx.userId, text: args.text }),
    ),
    editMessage: defineMutator(
      workspaceArguments.extend({ messageId: messageIdArgument, text: z.string() }),
      ({ tx, ctx, args }) =>
        editMessage(dependenciesOf(tx, ctx, args), {
          messageId: args.messageId,
          editorId: ctx.userId,
          text: args.text,
        }),
    ),
    deleteMessage: defineMutator(workspaceArguments.extend({ messageId: messageIdArgument }), ({ tx, ctx, args }) =>
      deleteMessage(dependenciesOf(tx, ctx, args), { messageId: args.messageId, deleterId: ctx.userId }),
    ),
    markChatRead: defineMutator(workspaceArguments.extend({ chatId: chatIdArgument }), ({ tx, ctx, args }) =>
      markChatRead(dependenciesOf(tx, ctx, args), {
        workspaceId: ctx.workspaceId,
        chatId: args.chatId,
        memberId: ctx.userId,
      }),
    ),
    startRuntimeFromMessage: defineMutator(
      workspaceArguments.extend({ id, chatId: chatIdArgument, messageId: messageIdArgument }),
      async ({ tx, ctx, args }) => {
        await startRuntimeFromMessage(
          { ...dependenciesOf(tx, ctx, args), runtimeChatStarter: createZeroRuntimeChatStarter(tx, ctx, args.chatId) },
          { messageId: args.messageId, memberId: ctx.userId },
        )
      },
    ),
  },
})
