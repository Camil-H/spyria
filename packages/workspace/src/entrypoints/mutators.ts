import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import type { ZeroContext } from '@spyria/db/zero-queries'
import { chatId, ForeignWorkspace, memberId, projectId, workspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import { Name } from '../domain/name.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { archiveChat } from '../operations/archive-chat.ts'
import { archiveProject } from '../operations/archive-project.ts'
import { changeMemberRole } from '../operations/change-member-role.ts'
import { changeVisibility } from '../operations/change-visibility.ts'
import { createChat } from '../operations/create-chat.ts'
import { createChatRole } from '../operations/create-chat-role.ts'
import { createProject } from '../operations/create-project.ts'
import { createWorkspace } from '../operations/create-workspace.ts'
import { createWorkspaceRole } from '../operations/create-workspace-role.ts'
import { deleteChatRole } from '../operations/delete-chat-role.ts'
import { deleteWorkspace } from '../operations/delete-workspace.ts'
import { deleteWorkspaceRole } from '../operations/delete-workspace-role.ts'
import { inviteMember } from '../operations/invite-member.ts'
import { moveChat } from '../operations/move-chat.ts'
import { removeMember } from '../operations/remove-member.ts'
import { renameChat } from '../operations/rename-chat.ts'
import { renameProject } from '../operations/rename-project.ts'
import { revokeInvite } from '../operations/revoke-invite.ts'
import { setDevLoop } from '../operations/set-dev-loop.ts'
import { transferChat } from '../operations/transfer-chat.ts'
import { updateChatRole } from '../operations/update-chat-role.ts'
import { updateWorkspaceRole } from '../operations/update-workspace-role.ts'

const id = z.string().check(z.minLength(1))
const name = z.pipe(z.string(), z.transform(Name))
const chatIdArgument = z.pipe(id, z.transform(chatId))
const projectIdArgument = z.pipe(id, z.transform(projectId))

const memberIdArgument = z.pipe(id, z.transform(memberId))
const visibilityArgument = z.enum(['public', 'private'])
const roleArgument = id
const roleArguments = {
  name: z.string().check(z.maxLength(200)),
  permissions: z.array(z.string().check(z.maxLength(64))).check(z.maxLength(16)),
}

const stepArgument = z.union([
  z.object({
    kind: z.literal('command'),
    name: z.string(),
    command: z.string(),
    timeoutMinutes: z.number(),
    fixes: z.number(),
  }),
  z.object({ kind: z.literal('review'), fixes: z.number() }),
  z.object({ kind: z.literal('pull_request') }),
  z.object({ kind: z.literal('ci'), checks: z.nullable(z.array(z.string())), fixes: z.number() }),
])
const devLoopArgument = z.nullable(
  z.object({
    isOn: z.boolean(),
    timeLimitMinutes: z.number(),
    costLimitMicros: z.nullable(z.number()),
    pipelines: z.array(
      z.object({
        repository: z.nullable(z.string()),
        setupCommand: z.nullable(z.string()),
        steps: z.array(stepArgument),
      }),
    ),
  }),
)
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
    setDevLoop: defineMutator(z.extend(workspaceArguments, { settings: devLoopArgument }), ({ tx, ctx, args }) =>
      setDevLoop(dependenciesOf(tx, ctx, args), { actorId: ctx.userId, settings: args.settings }),
    ),
    deleteWorkspace: defineMutator(
      z.extend(workspaceArguments, { confirmation: z.literal('DELETE') }),
      async ({ tx, ctx, args }) => {
        if (tx.location === 'server')
          await deleteWorkspace(dependenciesOf(tx, ctx, args), { actorId: ctx.userId, now: Date.now() })
      },
    ),
    createChatRole: defineMutator(z.extend(workspaceArguments, { id, ...roleArguments }), ({ tx, ctx, args }) =>
      createChatRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    updateChatRole: defineMutator(z.extend(workspaceArguments, { roleId: id, ...roleArguments }), ({ tx, ctx, args }) =>
      updateChatRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    deleteChatRole: defineMutator(z.extend(workspaceArguments, { roleId: id }), async ({ tx, ctx, args }) => {
      if (tx.location === 'server')
        await deleteChatRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId })
    }),
    createWorkspaceRole: defineMutator(z.extend(workspaceArguments, { id, ...roleArguments }), ({ tx, ctx, args }) =>
      createWorkspaceRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    updateWorkspaceRole: defineMutator(
      z.extend(workspaceArguments, { roleId: id, ...roleArguments }),
      ({ tx, ctx, args }) => updateWorkspaceRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId }),
    ),
    deleteWorkspaceRole: defineMutator(z.extend(workspaceArguments, { roleId: id }), async ({ tx, ctx, args }) => {
      if (tx.location === 'server')
        await deleteWorkspaceRole(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId })
    }),
    transferChat: defineMutator(
      z.extend(workspaceArguments, { chatId: chatIdArgument, ownerId: memberIdArgument }),
      async ({ tx, ctx, args }) => {
        if (tx.location === 'server')
          await transferChat(dependenciesOf(tx, ctx, args), { ...args, actorId: ctx.userId })
      },
    ),
  },
})
