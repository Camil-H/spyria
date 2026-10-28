import type { Transaction } from '@rocicorp/zero'
import {
  appendChatEvent,
  appendWorkspaceEvent,
  awaitsDomainVerification,
  copyWorkspaceSignIn,
  deleteMemberSessions,
  enqueueJob,
  lockActiveAdminIds,
  scheduleWorkspaceDeletion,
} from '@spyria/db/server-writes'
import type {
  Chat as ChatRow,
  Invitation as InvitationRow,
  Membership as MembershipRow,
  Project as ProjectRow,
} from '@spyria/db/zero'
import {
  chatPermissionsOf,
  transactorOver,
  workspacePermissionsOf,
  type ZeroContext,
  zql,
} from '@spyria/db/zero-queries'
import {
  adminRoleId,
  builtInChatRoles,
  builtInWorkspaceRoles,
  ChatNotFound,
  type ChatPermission,
  type ChatRole,
  chatId,
  ForeignWorkspace,
  memberId,
  memberRoleId,
  projectId,
  type WorkspacePermission,
  type WorkspaceRole,
  workspaceId,
  workspacePermissions,
} from '@spyria/kernel'
import { removeMemberProfileOnServer } from '@spyria/profile/published'
import {
  removeChatRuntimeOnServer,
  removeMemberMachineOnServer,
  stopChatRuntimeOnServer,
} from '@spyria/runtime/published'
import type { UnitOfWork, WorkspaceTransactor } from '../contracts/transactor.ts'
import type { Chat, ChatChange } from '../domain/chat.ts'
import { ProjectNotFound } from '../domain/errors.ts'
import type { Invitation } from '../domain/invitation.ts'
import { type Member, workspaceJobTypes } from '../domain/member.ts'
import { Name } from '../domain/name.ts'
import type { Project } from '../domain/project.ts'

const toProject = ({ createdAt, ...row }: ProjectRow): Project => ({
  ...row,
  id: projectId(row.id),
  workspaceId: workspaceId(row.workspaceId),
  name: Name(row.name),
})

const toChat = ({ createdAt, ownerKind, ownerUserId, ownerServiceIdentityId, ...row }: ChatRow): Chat => ({
  ...row,
  id: chatId(row.id),
  workspaceId: workspaceId(row.workspaceId),
  projectId: row.projectId === null ? null : projectId(row.projectId),
  originChatId: row.originChatId === null ? null : chatId(row.originChatId),
  ownerId: memberId(ownerUserId ?? ''),
  name: Name(row.name),
})

const chatFields = ({ ownerId, ...chat }: Chat) => chat

const toMember = (row: MembershipRow): Member => ({
  workspaceId: workspaceId(row.workspaceId),
  id: memberId(row.userId),
  role: row.role,
  removedAt: row.removedAt ?? null,
})

const toInvitation = (row: InvitationRow): Invitation => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  invitedBy: memberId(row.invitedBy),
  revokedAt: row.revokedAt ?? null,
  acceptedAt: row.acceptedAt ?? null,
})

const eventPayloadOf: Record<ChatChange['type'], (chat: Chat) => object> = {
  'chat.created': ({ name, type, projectId, originChatId, repository, baseBranch }) => ({
    name,
    type,
    projectId,
    ...(originChatId && { originChatId }),
    ...(repository && { repository, baseBranch }),
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
  const membershipsInContext = zql.memberships.where('workspaceId', context.workspaceId)
  const invitationsInContext = zql.invitations.where('workspaceId', context.workspaceId)
  const chatsInContext = zql.chats.where('workspaceId', context.workspaceId)
  const chatRolesInContext = zql.chatRoles.where('workspaceId', context.workspaceId)
  const workspaceRolesInContext = zql.workspaceRoles.where('workspaceId', context.workspaceId)
  const workspaceRoleOf = (row: {
    id: string
    name: string
    builtIn: boolean
    permissions: readonly { permission: string }[]
  }) => ({
    id: row.id,
    name: row.name,
    builtIn: row.builtIn,
    permissions: workspacePermissions.filter((permission) =>
      row.permissions.some((granted) => granted.permission === permission),
    ),
  })
  const insertWorkspaceRole = async (inWorkspaceId: string, role: WorkspaceRole, builtIn: boolean) => {
    await tx.mutate.workspaceRoles.insert({ workspaceId: inWorkspaceId, id: role.id, name: role.name, builtIn })
    for (const permission of role.permissions)
      await tx.mutate.workspaceRolePermissions.insert({ workspaceId: inWorkspaceId, roleId: role.id, permission })
  }
  const grantsOf = async (roleId: string) =>
    tx.run(zql.workspaceRolePermissions.where('workspaceId', context.workspaceId).where('roleId', roleId))
  const chatRoleRowOf = (role: ChatRole) => ({
    workspaceId: context.workspaceId,
    id: role.id,
    name: role.name,
    permissions: [...role.permissions],
  })
  const recordChatEvent = async (event: Omit<Parameters<typeof appendChatEvent>[1], 'workspaceId' | 'createdAt'>) => {
    if (tx.location === 'server')
      await appendChatEvent(tx, { ...event, workspaceId: context.workspaceId, createdAt: new Date() })
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
        for (const role of builtInWorkspaceRoles) await insertWorkspaceRole(id, role, true)
        await copyWorkspaceSignIn(tx, {
          fromWorkspaceId: context.workspaceId,
          toWorkspaceId: id,
          userId: context.userId,
        })
      },
      scheduleDeletion: async ({ purgeAt, haltDelayMilliseconds, actorId }) => {
        await scheduleWorkspaceDeletion(tx, context.workspaceId, purgeAt)
        await enqueueJob(tx, {
          workspaceId: context.workspaceId,
          type: workspaceJobTypes.halt,
          payload: { actorId },
          delayMilliseconds: haltDelayMilliseconds,
        })
        await enqueueJob(tx, {
          workspaceId: context.workspaceId,
          type: workspaceJobTypes.purge,
          payload: { stage: 'release', actorId },
          delayMilliseconds: Math.max(purgeAt - Date.now(), 0),
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
          role: adminRoleId,
          displayName: creator?.displayName ?? '',
        })
      },
      get: async (id) => {
        const row = await tx.run(membershipsInContext.where('userId', id).one())
        return row && toMember(row)
      },
      findByEmail: async (email) => {
        const user = await tx.run(
          zql.users
            .where('email', email)
            .related('memberships', (membership) => membership.where('workspaceId', context.workspaceId)),
        )
        const [row] = user.flatMap((found) => found.memberships)
        return row && toMember(row)
      },
      permissions: (id) => workspacePermissionsOf(tx, context.workspaceId, id),
      activeAdminIds: async () => {
        await lockActiveAdminIds(tx, context.workspaceId)
        const admins = await tx.run(membershipsInContext.where('role', adminRoleId).where('removedAt', 'IS', null))
        return admins.map((row) => memberId(row.userId))
      },
      save: ({ id, role, removedAt }) =>
        tx.mutate.memberships.update({ workspaceId: context.workspaceId, userId: id, role, removedAt }),
    },
    invitations: {
      get: async (id) => {
        const row = await tx.run(invitationsInContext.where('id', id).one())
        return row && toInvitation(row)
      },
      findOpen: async (email) => {
        const row = await tx.run(
          invitationsInContext
            .where('email', email)
            .where('revokedAt', 'IS', null)
            .where('acceptedAt', 'IS', null)
            .one(),
        )
        return row && toInvitation(row)
      },
      awaitsDomainVerification: () => awaitsDomainVerification(tx, context.workspaceId),
      add: (invitation) => tx.mutate.invitations.insert(inContextWorkspace(invitation)),
      save: (invitation) => tx.mutate.invitations.update(inContextWorkspace(invitation)),
    },
    memberAccess: {
      revoke: async (id) => {
        await deleteMemberSessions(tx, context.workspaceId, id)
        await removeMemberMachineOnServer(tx, context.workspaceId, id)
        await removeMemberProfileOnServer(tx, context.workspaceId, id)
      },
      stopTurnsLater: async (change) => {
        await enqueueJob(tx, {
          workspaceId: context.workspaceId,
          type: workspaceJobTypes.memberRemoved,
          payload: change,
          delayMilliseconds: 0,
        })
      },
    },
    workspaceEvents: {
      record: async (event) => {
        await appendWorkspaceEvent(tx, { ...event, workspaceId: context.workspaceId })
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
      listRuntimeChats: async () => (await tx.run(chatsInContext.where('type', 'runtime'))).map(toChat),
      ...chatPermissionsOf(tx, context.workspaceId),
      participantRoles: async (id) =>
        (
          await tx.run(
            zql.chatParticipants.where('workspaceId', context.workspaceId).where('chatId', id).related('role'),
          )
        ).map((row) => ({
          memberId: memberId(row.userId),
          permissions: (row.role?.permissions ?? []) as ChatPermission[],
        })),
      changeRole: async ({ chatId: id, memberId: member, roleId, actorId }) => {
        await tx.mutate.chatParticipants.update({
          workspaceId: context.workspaceId,
          chatId: id,
          userId: member,
          roleId,
        })
        await recordChatEvent({
          chatId: id,
          type: 'member.role_changed',
          actor: actorId,
          payload: { memberId: member, roleId },
        })
      },
      participatedBy: async (member) =>
        (
          await tx.run(
            chatsInContext.where(({ or, cmp, exists }) =>
              or(
                cmp('ownerUserId', member),
                exists('participants', (participant) => participant.where('userId', member)),
              ),
            ),
          )
        ).map(toChat),
      removeParticipant: async ({ chatId: id, memberId: member, actorId }) => {
        await tx.mutate.chatParticipants.delete({ workspaceId: context.workspaceId, chatId: id, userId: member })
        await recordChatEvent({ chatId: id, type: 'member.removed', actor: actorId, payload: { memberId: member } })
      },
      transfer: async ({ chat, ownerId, actorId }) => {
        const participant = { workspaceId: context.workspaceId, chatId: chat.id }
        await tx.mutate.chatParticipants.delete({ ...participant, userId: chat.ownerId })
        await tx.mutate.chatParticipants.upsert({ ...participant, userId: ownerId, roleId: 'owner' })
        await tx.mutate.chats.update({ workspaceId: context.workspaceId, id: chat.id, ownerUserId: ownerId })
        await recordChatEvent({
          chatId: chat.id,
          type: 'chat.transferred',
          actor: actorId,
          payload: { fromId: chat.ownerId, toId: ownerId },
        })
      },
    },
    chatRoles: {
      get: async (id) => {
        const row = await tx.run(chatRolesInContext.where('id', id).one())
        return row && { ...row, permissions: row.permissions as ChatPermission[] }
      },
      list: async () =>
        (await tx.run(chatRolesInContext)).map((row) => ({ ...row, permissions: row.permissions as ChatPermission[] })),
      holders: async (id) => {
        const rows = await tx.run(zql.chatParticipants.where('workspaceId', context.workspaceId).where('roleId', id))
        return {
          memberCount: new Set(rows.map((row) => row.userId)).size,
          chatCount: new Set(rows.map((row) => row.chatId)).size,
        }
      },
      add: (role) => tx.mutate.chatRoles.insert({ ...chatRoleRowOf(role), builtIn: false }),
      save: (role) => tx.mutate.chatRoles.update(chatRoleRowOf(role)),
      remove: (id) => tx.mutate.chatRoles.delete({ workspaceId: context.workspaceId, id }),
    },
    workspaceRoles: {
      get: async (id) => {
        const row = await tx.run(workspaceRolesInContext.where('id', id).related('permissions').one())
        return row && workspaceRoleOf(row)
      },
      list: async () => (await tx.run(workspaceRolesInContext.related('permissions'))).map(workspaceRoleOf),
      holders: async (id) => ({
        memberCount: (await tx.run(membershipsInContext.where('role', id).where('removedAt', 'IS', null))).length,
        inviteCount: (
          await tx.run(
            invitationsInContext.where('role', id).where('revokedAt', 'IS', null).where('acceptedAt', 'IS', null),
          )
        ).length,
      }),
      add: (role) => insertWorkspaceRole(context.workspaceId, role, false),
      save: async (role) => {
        await tx.mutate.workspaceRoles.update({ workspaceId: context.workspaceId, id: role.id, name: role.name })
        for (const granted of await grantsOf(role.id))
          if (!role.permissions.includes(granted.permission as WorkspacePermission))
            await tx.mutate.workspaceRolePermissions.delete(granted)
        for (const permission of role.permissions)
          await tx.mutate.workspaceRolePermissions.upsert({
            workspaceId: context.workspaceId,
            roleId: role.id,
            permission,
          })
      },
      remove: async (id) => {
        for (const removed of await tx.run(membershipsInContext.where('role', id).where('removedAt', 'IS NOT', null)))
          await tx.mutate.memberships.update({ ...removed, role: memberRoleId })
        for (const granted of await grantsOf(id)) await tx.mutate.workspaceRolePermissions.delete(granted)
        await tx.mutate.workspaceRoles.delete({ workspaceId: context.workspaceId, id })
      },
    },
    chatRuntimes: {
      remove: (chatId) => removeChatRuntimeOnServer(tx, context.workspaceId, chatId),
      stop: (chatId) => stopChatRuntimeOnServer(tx, context.workspaceId, chatId),
    },
  }
  return transactorOver(tx, unitOfWork)
}
