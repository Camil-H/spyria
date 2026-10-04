import type { ZeroContext } from '@hq/db/zero-queries'
import { chatId, projectId } from '@hq/kernel'
import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import { z } from 'zod'
import { runtimeChatDefaults } from '../domain/chat.ts'
import { ForeignWorkspace } from '../domain/errors.ts'
import { Name } from '../domain/name.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { archiveChat } from '../operations/archive-chat.ts'
import { archiveProject } from '../operations/archive-project.ts'
import { createChat } from '../operations/create-chat.ts'
import { createChatFromChat } from '../operations/create-chat-from-chat.ts'
import { createProject } from '../operations/create-project.ts'
import { createWorkspace } from '../operations/create-workspace.ts'
import { moveChat } from '../operations/move-chat.ts'
import { renameChat } from '../operations/rename-chat.ts'
import { renameProject } from '../operations/rename-project.ts'

const id = z.string().min(1)
const name = z.string().transform(Name)
const chatIdArgument = id.transform(chatId)
const projectIdArgument = id.transform(projectId)

const workspaceArguments = z.object({ workspaceId: id })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string; id?: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new ForeignWorkspace()
  return {
    transactor: createZeroTransactor(tx, context),
    idGenerator: { next: () => args.id ?? '' },
    ...runtimeChatDefaults,
  }
}

export const workspaceMutators = defineMutators({
  workspace: {
    createProject: defineMutator(workspaceArguments.extend({ id, name }), async ({ tx, ctx, args }) => {
      await createProject(dependenciesOf(tx, ctx, args), { workspaceId: ctx.workspaceId, name: args.name })
    }),
    createChat: defineMutator(
      workspaceArguments.extend({
        id,
        name,
        type: z.enum(['channel', 'runtime']),
        projectId: projectIdArgument.nullable(),
      }),
      async ({ tx, ctx, args }) => {
        await createChat(dependenciesOf(tx, ctx, args), {
          workspaceId: ctx.workspaceId,
          ownerId: ctx.userId,
          name: args.name,
          type: args.type,
          projectId: args.projectId,
        })
      },
    ),
    createChatFromChat: defineMutator(
      workspaceArguments.extend({ id, name: z.string(), sourceChatId: chatIdArgument }),
      async ({ tx, ctx, args }) => {
        await createChatFromChat(dependenciesOf(tx, ctx, args), {
          sourceChatId: args.sourceChatId,
          name: args.name,
          ownerId: ctx.userId,
        })
      },
    ),
    moveChat: defineMutator(
      workspaceArguments.extend({ chatId: chatIdArgument, projectId: projectIdArgument.nullable() }),
      ({ tx, ctx, args }) => moveChat(dependenciesOf(tx, ctx, args), args),
    ),
    archiveChat: defineMutator(workspaceArguments.extend({ chatId: chatIdArgument }), ({ tx, ctx, args }) =>
      archiveChat(dependenciesOf(tx, ctx, args), args),
    ),
    archiveProject: defineMutator(
      workspaceArguments.extend({ projectId: projectIdArgument, chatsPolicy: z.enum(['archive', 'release']) }),
      ({ tx, ctx, args }) => archiveProject(dependenciesOf(tx, ctx, args), args),
    ),
    renameChat: defineMutator(workspaceArguments.extend({ chatId: chatIdArgument, name }), ({ tx, ctx, args }) =>
      renameChat(dependenciesOf(tx, ctx, args), args),
    ),
    renameProject: defineMutator(
      workspaceArguments.extend({ projectId: projectIdArgument, name }),
      ({ tx, ctx, args }) => renameProject(dependenciesOf(tx, ctx, args), args),
    ),
    createWorkspace: defineMutator(workspaceArguments.extend({ id, name }), async ({ tx, ctx, args }) => {
      await createWorkspace(dependenciesOf(tx, ctx, args), { ownerId: ctx.userId, name: args.name })
    }),
  },
})
