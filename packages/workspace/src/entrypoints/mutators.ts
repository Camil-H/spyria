import type { ZeroContext } from '@hq/db/zero-queries'
import { chatId, memberId, projectId, workspaceId } from '@hq/kernel'
import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import { ForeignWorkspace } from '../domain/errors.ts'
import { Name } from '../domain/name.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { archiveChat } from '../operations/archive-chat.ts'
import { archiveProject } from '../operations/archive-project.ts'
import { changeMemberRole } from '../operations/change-member-role.ts'
import { changeVisibility } from '../operations/change-visibility.ts'
import { createChat } from '../operations/create-chat.ts'
import { createProject } from '../operations/create-project.ts'
import { createWorkspace } from '../operations/create-workspace.ts'
import { inviteMember } from '../operations/invite-member.ts'
import { moveChat } from '../operations/move-chat.ts'
import { removeMember } from '../operations/remove-member.ts'
import { renameChat } from '../operations/rename-chat.ts'
import { renameProject } from '../operations/rename-project.ts'
import { revokeInvite } from '../operations/revoke-invite.ts'
import { transferChat } from '../operations/transfer-chat.ts'

const id = z.string().check(z.minLength(1))
const name = z.pipe(z.string(), z.transform(Name))
const chatIdArgument = z.pipe(id, z.transform(chatId))
const projectIdArgument = z.pipe(id, z.transform(projectId))

const memberIdArgument = z.pipe(id, z.transform(memberId))
const visibilityArgument = z.enum(['public', 'private'])
const roleArgument = z.enum(['admin', 'member'])

const workspaceArguments = z.object({ workspaceId: z.pipe(id, z.transform(workspaceId)) })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new ForeignWorkspace()
  return { transactor: createZeroTransactor(tx, context) }
}

export const workspaceMutators = defineMutators({
  workspace: {
    createProject: defineMutator(z.extend(workspaceArguments, { id, name }), ({ tx, ctx, args }) =>
      createProject(dependenciesOf(tx, ctx, args), args),
    ),
    createChat: defineMutator(
      z.extend(workspaceArguments, {
        id,
        name,
        type: z.enum(['channel', 'runtime']),
        visibility: z.optional(visibilityArgument),
        projectId: z.nullable(projectIdArgument),
      }),
      ({ tx, ctx, args }) => createChat(dependenciesOf(tx, ctx, args), { ...args, ownerId: ctx.userId }),
    ),
    moveChat: defineMutator(
      z.extend(workspaceArguments, { chatId: chatIdArgument, projectId: z.nullable(projectIdArgument) }),
      ({ tx, ctx, args }) => moveChat(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    archiveChat: defineMutator(z.extend(workspaceArguments, { chatId: chatIdArgument }), ({ tx, ctx, args }) =>
      archiveChat(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    archiveProject: defineMutator(
      z.extend(workspaceArguments, { projectId: projectIdArgument, chatsPolicy: z.enum(['archive', 'release']) }),
      ({ tx, ctx, args }) => archiveProject(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    renameChat: defineMutator(z.extend(workspaceArguments, { chatId: chatIdArgument, name }), ({ tx, ctx, args }) =>
      renameChat(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    changeVisibility: defineMutator(
      z.extend(workspaceArguments, { chatId: chatIdArgument, visibility: visibilityArgument }),
      ({ tx, ctx, args }) => changeVisibility(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    renameProject: defineMutator(
      z.extend(workspaceArguments, { projectId: projectIdArgument, name }),
      ({ tx, ctx, args }) => renameProject(dependenciesOf(tx, ctx, args), args),
    ),
    createWorkspace: defineMutator(z.extend(workspaceArguments, { id, name }), ({ tx, ctx, args }) =>
      createWorkspace(dependenciesOf(tx, ctx, args), { ...args, ownerId: ctx.userId }),
    ),
    inviteMember: defineMutator(
      z.extend(workspaceArguments, { id, email: z.string().check(z.maxLength(320)), role: roleArgument }),
      ({ tx, ctx, args }) =>
        inviteMember(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId, now: Date.now() }),
    ),
    revokeInvite: defineMutator(z.extend(workspaceArguments, { invitationId: id }), ({ tx, ctx, args }) =>
      revokeInvite(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId, now: Date.now() }),
    ),
    changeMemberRole: defineMutator(
      z.extend(workspaceArguments, { memberId: memberIdArgument, role: roleArgument }),
      ({ tx, ctx, args }) => changeMemberRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    removeMember: defineMutator(z.extend(workspaceArguments, { memberId: memberIdArgument }), ({ tx, ctx, args }) =>
      removeMember(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId, now: Date.now() }),
    ),
    transferChat: defineMutator(
      z.extend(workspaceArguments, { chatId: chatIdArgument, ownerId: memberIdArgument }),
      async ({ tx, ctx, args }) => {
        if (tx.location === 'server')
          await transferChat(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId })
      },
    ),
  },
})
