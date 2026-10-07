import type { ZeroContext } from '@hq/db/zero-queries'
import { chatId, messageId } from '@hq/kernel'
import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import { ForeignWorkspace } from '../domain/errors.ts'
import { createZeroRuntimeRetrier } from '../integrations/runtime-agent-runtimes.ts'
import { createZeroRuntimeChatStarter } from '../integrations/workspace-runtime-chat-starter.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { deleteMessage } from '../operations/delete-message.ts'
import { editMessage } from '../operations/edit-message.ts'
import { markChatRead } from '../operations/mark-chat-read.ts'
import { retryAgent } from '../operations/retry-agent.ts'
import { sendMessage } from '../operations/send-message.ts'
import { startRuntimeFromMessage } from '../operations/start-runtime-from-message.ts'
import { stopAgent } from '../operations/stop-agent.ts'
import { updateChatRouting } from '../operations/update-chat-routing.ts'

const id = z.string().check(z.minLength(1))
const chatIdArgument = z.pipe(id, z.transform(chatId))
const messageIdArgument = z.pipe(id, z.transform(messageId))

const workspaceArguments = z.object({ workspaceId: id })
const chatArguments = z.extend(workspaceArguments, { chatId: chatIdArgument })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new ForeignWorkspace()
  return { transactor: createZeroTransactor(tx, context.workspaceId) }
}

export const conversationMutators = defineMutators({
  conversation: {
    sendMessage: defineMutator(
      z.extend(workspaceArguments, { id, chatId: chatIdArgument, text: z.string() }),
      ({ tx, ctx, args }) => sendMessage(dependenciesOf(tx, ctx, args), { ...args, authorId: ctx.userId }),
    ),
    editMessage: defineMutator(
      z.extend(workspaceArguments, { messageId: messageIdArgument, text: z.string() }),
      ({ tx, ctx, args }) => editMessage(dependenciesOf(tx, ctx, args), { ...args, editorId: ctx.userId }),
    ),
    deleteMessage: defineMutator(z.extend(workspaceArguments, { messageId: messageIdArgument }), ({ tx, ctx, args }) =>
      deleteMessage(dependenciesOf(tx, ctx, args), { ...args, deleterId: ctx.userId }),
    ),
    markChatRead: defineMutator(chatArguments, ({ tx, ctx, args }) =>
      markChatRead(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId }),
    ),
    stopAgent: defineMutator(chatArguments, async ({ tx, ctx, args }) => {
      if (tx.location === 'server') await stopAgent(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId })
    }),
    retryAgent: defineMutator(chatArguments, async ({ tx, ctx, args }) => {
      if (tx.location === 'server')
        await retryAgent(
          { ...dependenciesOf(tx, ctx, args), runtimeRetrier: createZeroRuntimeRetrier(tx) },
          { workspaceId: ctx.workspaceId, chatId: args.chatId },
        )
    }),
    updateChatRouting: defineMutator(
      z.extend(chatArguments, {
        sessionModel: z.optional(z.string()),
        defaultModel: z.optional(z.string()),
        subagentPolicy: z.optional(z.enum(['auto', 'same_as_main'])),
      }),
      ({ tx, ctx, args }) => updateChatRouting(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId }),
    ),
    startRuntimeFromMessage: defineMutator(
      z.extend(workspaceArguments, { id, chatId: chatIdArgument, messageId: messageIdArgument }),
      ({ tx, ctx, args }) =>
        startRuntimeFromMessage(
          { ...dependenciesOf(tx, ctx, args), runtimeChatStarter: createZeroRuntimeChatStarter(tx, ctx) },
          { ...args, memberId: ctx.userId },
        ),
    ),
  },
})
