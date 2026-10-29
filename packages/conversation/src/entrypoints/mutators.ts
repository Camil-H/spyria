import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import type { ZeroContext } from '@spyria/db/zero-queries'
import { chatId, ForeignWorkspace, memberId, messageId } from '@spyria/kernel'
import { z } from 'zod/mini'
import { maximumAttachmentsPerMessage } from '../domain/attachments.ts'
import { runsOns } from '../domain/session-routing.ts'
import { createZeroRuntimeRetrier } from '../integrations/runtime-agent-runtimes.ts'
import { createZeroRuntimeChatStarter } from '../integrations/workspace-runtime-chat-starter.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { changeMemberRole } from '../operations/change-member-role.ts'
import { deleteMessage } from '../operations/delete-message.ts'
import { editMessage } from '../operations/edit-message.ts'
import { forkChat } from '../operations/fork-chat.ts'
import { inviteMember } from '../operations/invite-member.ts'
import { joinChat } from '../operations/join-chat.ts'
import { leaveChat } from '../operations/leave-chat.ts'
import { markChatRead } from '../operations/mark-chat-read.ts'
import { markThreadRead } from '../operations/mark-thread-read.ts'
import { removeMember } from '../operations/remove-member.ts'
import { restartSession } from '../operations/restart-session.ts'
import { retryAgent } from '../operations/retry-agent.ts'
import { sendMessage } from '../operations/send-message.ts'
import { startRuntimeFromMessage } from '../operations/start-runtime-from-message.ts'
import { stopAgent } from '../operations/stop-agent.ts'
import { stopRuntime } from '../operations/stop-runtime.ts'
import { updateChatRouting } from '../operations/update-chat-routing.ts'

const id = z.string().check(z.minLength(1))
const chatIdArgument = z.pipe(id, z.transform(chatId))
const messageIdArgument = z.pipe(id, z.transform(messageId))
const memberIdArgument = z.pipe(id, z.transform(memberId))

const workspaceArguments = z.object({ workspaceId: id })
const chatArguments = z.extend(workspaceArguments, { chatId: chatIdArgument })
const memberArguments = z.extend(chatArguments, { memberId: memberIdArgument })
const memberRoleArguments = z.extend(memberArguments, { roleId: id })
const attachmentArgument = z.object({ id, name: z.string(), mediaType: z.string(), size: z.number() })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new ForeignWorkspace()
  return { transactor: createZeroTransactor(tx, context.workspaceId) }
}

export const conversationMutators = defineMutators({
  conversation: {
    sendMessage: defineMutator(
      z.extend(workspaceArguments, {
        id,
        chatId: chatIdArgument,
        text: z.string(),
        threadRootId: z.optional(messageIdArgument),
        quotedMessageId: z.optional(messageIdArgument),
        attachments: z.optional(z.array(attachmentArgument).check(z.maxLength(maximumAttachmentsPerMessage))),
      }),
      ({ tx, ctx, args }) =>
        sendMessage(
          { ...dependenciesOf(tx, ctx, args), limitMessage: ctx.limitMessage },
          { ...args, authorId: ctx.userId },
        ),
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
    markThreadRead: defineMutator(z.extend(chatArguments, { threadRootId: messageIdArgument }), ({ tx, ctx, args }) =>
      markThreadRead(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId }),
    ),
    stopAgent: defineMutator(chatArguments, async ({ tx, ctx, args }) => {
      if (tx.location === 'server') await stopAgent(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId })
    }),
    restartSession: defineMutator(chatArguments, async ({ tx, ctx, args }) => {
      if (tx.location === 'server')
        await restartSession(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId })
    }),
    stopRuntime: defineMutator(chatArguments, async ({ tx, ctx, args }) => {
      if (tx.location === 'server') await stopRuntime(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId })
    }),
    retryAgent: defineMutator(chatArguments, async ({ tx, ctx, args }) => {
      if (tx.location === 'server')
        await retryAgent(
          { ...dependenciesOf(tx, ctx, args), runtimeRetrier: createZeroRuntimeRetrier(tx, ctx) },
          { workspaceId: ctx.workspaceId, chatId: args.chatId, memberId: ctx.userId },
        )
    }),
    updateChatRouting: defineMutator(
      z.extend(chatArguments, {
        sessionModel: z.optional(z.string()),
        subagentPolicy: z.optional(z.enum(['auto', 'same_as_main'])),
        runsOn: z.optional(z.enum(runsOns)),
        adapterModel: z.optional(z.string()),
        reasoningEffort: z.optional(z.string().check(z.regex(/^[a-z]{1,16}$/))),
      }),
      ({ tx, ctx, args }) => updateChatRouting(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId }),
    ),
    inviteMember: defineMutator(memberRoleArguments, ({ tx, ctx, args }) =>
      inviteMember(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    changeMemberRole: defineMutator(memberRoleArguments, ({ tx, ctx, args }) =>
      changeMemberRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    removeMember: defineMutator(memberArguments, ({ tx, ctx, args }) =>
      removeMember(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    joinChat: defineMutator(chatArguments, ({ tx, ctx, args }) =>
      joinChat(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId }),
    ),
    leaveChat: defineMutator(chatArguments, ({ tx, ctx, args }) =>
      leaveChat(dependenciesOf(tx, ctx, args), { ...args, memberId: ctx.userId }),
    ),
    startRuntimeFromMessage: defineMutator(
      z.extend(workspaceArguments, { id, chatId: chatIdArgument, messageId: messageIdArgument }),
      ({ tx, ctx, args }) =>
        startRuntimeFromMessage(
          { ...dependenciesOf(tx, ctx, args), runtimeChatStarter: createZeroRuntimeChatStarter(tx, ctx) },
          { ...args, memberId: ctx.userId },
        ),
    ),
    forkChat: defineMutator(
      z.extend(workspaceArguments, { id, chatId: chatIdArgument, sourceChatId: chatIdArgument }),
      ({ tx, ctx, args }) =>
        forkChat(
          { ...dependenciesOf(tx, ctx, args), runtimeChatStarter: createZeroRuntimeChatStarter(tx, ctx) },
          { ...args, memberId: ctx.userId },
        ),
    ),
  },
})
