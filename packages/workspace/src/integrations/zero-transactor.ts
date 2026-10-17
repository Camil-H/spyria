import { appendChatEvent } from '@hq/db/server-writes'
import type { Chat as ChatRow, Project as ProjectRow } from '@hq/db/zero'
import { memberChatPermissions, type ZeroContext, zql } from '@hq/db/zero-queries'
import { builtInChatRoles, chatId, memberId, projectId, workspaceId } from '@hq/kernel'
import { removeChatRuntimeOnServer } from '@hq/runtime/published'
import type { Transaction } from '@rocicorp/zero'
import type { UnitOfWork, WorkspaceTransactor } from '../contracts/transactor.ts'
import type { Chat, ChatChange } from '../domain/chat.ts'
import { ChatNotFound, ForeignWorkspace, ProjectNotFound } from '../domain/errors.ts'
import { Name } from '../domain/name.ts'
import type { Project } from '../domain/project.ts'

const toProject = ({ createdAt, ...row }: ProjectRow): Project => ({
  ...row,
  id: projectId(row.id),
  workspaceId: workspaceId(row.workspaceId),
  name: Name(row.name),
})

const toChat = ({ createdAt, mode, ownerKind, ownerUserId, ownerServiceIdentityId, ...row }: ChatRow): Chat => ({
  ...row,
  id: chatId(row.id),
  workspaceId: workspaceId(row.workspaceId),
  projectId: row.projectId === null ? null : projectId(row.projectId),
  originChatId: row.originChatId === null ? null : chatId(row.originChatId),
  ownerId: memberId(ownerUserId ?? ''),
  name: Name(row.name),
})

const chatFields = ({ ownerId, ...chat }: Chat) => chat

const eventPayloadOf: Record<ChatChange['type'], (chat: Chat) => object> = {
  'chat.created': ({ name, type, projectId, originChatId }) => ({
    name,
    type,
    projectId,
    ...(originChatId && { originChatId }),
  }),
  'chat.renamed': ({ name }) => ({ name }),
  'chat.moved': ({ projectId }) => ({ projectId }),
  'chat.archived': () => ({}),
  'chat.visibility_changed': ({ visibility }) => ({ visibility }),
}

export const createZeroTransactor = (tx: Transaction, context: ZeroContext): WorkspaceTransactor => {
  const createdWorkspaceIds = new Set<string>()
  const inContextWorkspace = <Row extends { workspaceId: string }>(row: Row) => {
    if (row.workspaceId !== context.workspaceId) throw new ForeignWorkspace()
    return row
  }
  const unitOfWork: UnitOfWork = {
    workspaces: {
      add: async ({ id, name }) => {
        if (await tx.run(zql.workspaces.where('workspaceId', id).one())) throw new ForeignWorkspace()
        createdWorkspaceIds.add(id)
        await tx.mutate.workspaces.insert({ workspaceId: id, name, createdBy: context.userId, createdAt: Date.now() })
        for (const role of builtInChatRoles)
          await tx.mutate.chatRoles.insert({
            ...role,
            workspaceId: id,
            permissions: [...role.permissions],
            builtIn: true,
          })
      },
    },
    memberships: {
      add: async (membership) => {
        if (!createdWorkspaceIds.has(membership.workspaceId) || membership.memberId !== context.userId)
          throw new ForeignWorkspace()
        const creator = await tx.run(
          zql.memberships.where('workspaceId', context.workspaceId).where('userId', context.userId).one(),
        )
        await tx.mutate.memberships.insert({
          workspaceId: membership.workspaceId,
          userId: membership.memberId,
          role: 'admin',
          displayName: creator?.displayName ?? '',
        })
      },
    },
    projects: {
      get: async (id) => {
        const row = await tx.run(zql.projects.where('workspaceId', context.workspaceId).where('id', id).one())
        if (!row) throw new ProjectNotFound(id)
        return toProject(row)
      },
      add: (project) => tx.mutate.projects.insert({ ...inContextWorkspace(project), createdAt: Date.now() }),
      save: (project) => tx.mutate.projects.update(inContextWorkspace(project)),
    },
    chats: {
      get: async (id) => {
        const row = await tx.run(zql.chats.where('workspaceId', context.workspaceId).where('id', id).one())
        if (!row) throw new ChatNotFound(id)
        return toChat(row)
      },
      record: async ({ type, chat, actorId }) => {
        const changedAt = new Date()
        if (type === 'chat.created') {
          await tx.mutate.chats.insert({
            ...chatFields(inContextWorkspace(chat)),
            mode: null,
            ownerKind: 'user',
            ownerUserId: chat.ownerId,
            ownerServiceIdentityId: null,
            subagentPolicy: 'auto',
            localSession: chat.type === 'runtime' ? null : false,
            createdAt: changedAt.getTime(),
          })
          await tx.mutate.chatParticipants.insert({
            workspaceId: chat.workspaceId,
            chatId: chat.id,
            userId: chat.ownerId,
            roleId: 'owner',
          })
        } else await tx.mutate.chats.update(chatFields(inContextWorkspace(chat)))
        if (tx.location === 'server')
          await appendChatEvent(tx, {
            workspaceId: chat.workspaceId,
            chatId: chat.id,
            type,
            actor: actorId,
            payload: eventPayloadOf[type](chat),
            createdAt: changedAt,
          })
      },
      listByProject: async (id) =>
        (await tx.run(zql.chats.where('workspaceId', context.workspaceId).where('projectId', id))).map(toChat),
      permissions: (id, memberId) => memberChatPermissions(tx, context.workspaceId, id, memberId),
    },
    chatRuntimes: {
      remove: (chatId) => removeChatRuntimeOnServer(tx, context.workspaceId, chatId),
    },
  }
  return { run: (work) => work(unitOfWork) }
}
