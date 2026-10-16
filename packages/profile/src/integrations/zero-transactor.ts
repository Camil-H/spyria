import {
  enqueueJob,
  gatewayKeyRefOf,
  gatewayKeyRefsOf,
  insertLlmCredential,
  lockMembership,
  setVirtualKeyId,
  virtualKeyIdOf,
} from '@hq/db/server-writes'
import { type Transact, type ZeroContext, zql } from '@hq/db/zero-queries'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { DisplayName } from '../domain/display-name.ts'
import { CredentialNotFound, MemberNotFound, NotOwnProfile } from '../domain/errors.ts'
import { gatewayKeyOf, profileJobTypes, gatewayKeyRefOf as refOf } from '../domain/llm-credential.ts'

export const createZeroTransactor = (tx: Transaction, context: ZeroContext): ProfileTransactor => {
  const asContextMember = (workspaceId: WorkspaceId, memberId: MemberId) => {
    if (workspaceId !== context.workspaceId || memberId !== context.userId) throw new NotOwnProfile()
    return { workspaceId, userId: memberId }
  }
  const unitOfWork: UnitOfWork = {
    members: {
      get: async (workspaceId, memberId) => {
        asContextMember(workspaceId, memberId)
        const row = await tx.run(zql.memberships.where('workspaceId', workspaceId).where('userId', memberId).one())
        if (!row) throw new MemberNotFound(memberId)
        return { workspaceId, id: memberId, name: DisplayName(row.displayName) }
      },
      save: (member) =>
        tx.mutate.memberships.update({ ...asContextMember(member.workspaceId, member.id), displayName: member.name }),
    },
    llmCredentials: {
      add: async ({ workspaceId, memberId, id, provider, last4 }, key) => {
        asContextMember(workspaceId, memberId)
        await insertLlmCredential(tx, { workspaceId, id, userId: memberId, provider, last4, secretRef: refOf(key) })
      },
      remove: async (workspaceId, memberId, id) => {
        asContextMember(workspaceId, memberId)
        const row = await tx.run(
          zql.llmCredentials.where('workspaceId', workspaceId).where('userId', memberId).where('id', id).one(),
        )
        if (!row) throw new CredentialNotFound(id)
        const storedRef = await gatewayKeyRefOf(tx, workspaceId, id)
        await tx.mutate.llmCredentials.delete({ workspaceId, id })
        return storedRef ? gatewayKeyOf(storedRef) : undefined
      },
      gatewayKeysOf: async (workspaceId, memberId) => {
        asContextMember(workspaceId, memberId)
        return (await gatewayKeyRefsOf(tx, workspaceId, memberId)).flatMap((ref) => gatewayKeyOf(ref) ?? [])
      },
    },
    memberGatewayKeys: {
      virtualKeyOf: (workspaceId, memberId) => virtualKeyIdOf(tx, workspaceId, memberId),
      setVirtualKey: async (workspaceId, memberId, virtualKeyId) => {
        asContextMember(workspaceId, memberId)
        await setVirtualKeyId(tx, workspaceId, memberId, virtualKeyId)
      },
    },
    gatewayJobs: {
      syncLater: async (job) => {
        await enqueueJob(tx, {
          workspaceId: job.workspaceId,
          type: profileJobTypes.gatewaySync,
          payload: job,
          delayMilliseconds: 0,
        })
      },
    },
    personalConnections: {
      connect: async ({ workspaceId, memberId, tool, status }) => {
        const owner = asContextMember(workspaceId, memberId)
        await lockMembership(tx, workspaceId, memberId)
        const stored = await tx.run(zql.toolConnections.where('workspaceId', workspaceId).where('userId', memberId))
        if (stored.some((row) => row.tool === tool)) await tx.mutate.toolConnections.update({ ...owner, tool, status })
        else {
          const position = Math.max(0, ...stored.map((row) => row.position)) + 1
          await tx.mutate.toolConnections.insert({ ...owner, tool, status, position })
        }
      },
      disconnect: (workspaceId, memberId, tool) =>
        tx.mutate.toolConnections.delete({ ...asContextMember(workspaceId, memberId), tool }),
      statusOf: async (workspaceId, memberId, tool) =>
        (
          await tx.run(
            zql.toolConnections
              .where('workspaceId', asContextMember(workspaceId, memberId).workspaceId)
              .where('userId', memberId)
              .where('tool', tool)
              .one(),
          )
        )?.status,
    },
  }
  return { run: (work) => work(unitOfWork) }
}

export const memberContext = (workspace: WorkspaceId, member: MemberId): ZeroContext => ({
  workspaceId: workspace,
  userId: member,
  role: 'member',
})

export const createTransactingZeroTransactor = (transact: Transact, context: ZeroContext): ProfileTransactor => ({
  run: (work) => transact((tx) => createZeroTransactor(tx, context).run(work)),
})
