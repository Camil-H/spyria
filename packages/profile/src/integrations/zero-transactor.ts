import { toolCatalog } from '@hq/db'
import { type ToolConnection as ToolConnectionRow, zql } from '@hq/db/zero'
import type { ZeroContext } from '@hq/db/zero-queries'
import { type MemberId, memberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { DisplayName } from '../domain/display-name.ts'
import { CredentialNotFound, MemberNotFound, NotOwnProfile } from '../domain/errors.ts'
import { secretRef } from '../domain/llm-credential.ts'

const toConnection = ({ userId, position, ...row }: ToolConnectionRow) => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  memberId: memberId(userId),
})

export const createZeroTransactor = (tx: Transaction, context: ZeroContext): ProfileTransactor => {
  const serverQuery = async (statement: string, parameters: unknown[]) =>
    tx.location === 'server' ? [...(await tx.dbTransaction.query(statement, parameters))] : []
  const asContextMember = (workspaceId: WorkspaceId, memberId: MemberId) => {
    if (workspaceId !== context.workspaceId || memberId !== context.userId) throw new NotOwnProfile()
    return { workspaceId, userId: memberId }
  }
  const connectionsOf = (workspaceId: WorkspaceId, memberId: MemberId) =>
    tx.run(zql.toolConnections.where('workspaceId', workspaceId).where('userId', memberId).orderBy('position', 'asc'))
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
      add: async ({ workspaceId, memberId, id, provider, last4 }, secretRef) => {
        asContextMember(workspaceId, memberId)
        await serverQuery(
          'insert into llm_credentials (workspace_id, id, user_id, provider, last4, secret_ref) values ($1, $2, $3, $4, $5, $6)',
          [workspaceId, id, memberId, provider, last4, secretRef],
        )
      },
      remove: async (workspaceId, memberId, id) => {
        asContextMember(workspaceId, memberId)
        const row = await tx.run(
          zql.llmCredentials.where('workspaceId', workspaceId).where('userId', memberId).where('id', id).one(),
        )
        if (!row) throw new CredentialNotFound(id)
        const [stored] = await serverQuery(
          'select secret_ref from llm_credentials where workspace_id = $1 and id = $2',
          [workspaceId, id],
        )
        await tx.mutate.llmCredentials.delete({ workspaceId, id })
        return stored ? secretRef((stored as { secret_ref: string }).secret_ref) : null
      },
    },
    secrets: {
      keep: async (workspaceId, secret) => {
        const ref = secretRef(`placeholder:${crypto.randomUUID()}`)
        await serverQuery('insert into placeholder_secrets (workspace_id, ref, value) values ($1, $2, $3)', [
          workspaceId,
          ref,
          secret.reveal(),
        ])
        return ref
      },
      discard: async (workspaceId, ref) => {
        await serverQuery('delete from placeholder_secrets where workspace_id = $1 and ref = $2', [workspaceId, ref])
      },
    },
    personalConnections: {
      list: async (workspaceId, memberId) => {
        asContextMember(workspaceId, memberId)
        await serverQuery('select 1 from memberships where workspace_id = $1 and user_id = $2 for update', [
          workspaceId,
          memberId,
        ])
        return (await connectionsOf(workspaceId, memberId)).map(toConnection)
      },
      replace: async (workspaceId, memberId, connections) => {
        const owner = asContextMember(workspaceId, memberId)
        const stored = await connectionsOf(workspaceId, memberId)
        const nextTools = new Set(connections.map(({ tool }) => tool))
        for (const { tool } of stored)
          if (!nextTools.has(tool)) await tx.mutate.toolConnections.delete({ ...owner, tool })
        let nextPosition = Math.max(0, ...stored.map(({ position }) => position)) + 1
        for (const { tool, status } of connections) {
          const storedConnection = stored.find((row) => row.tool === tool)
          if (!storedConnection)
            await tx.mutate.toolConnections.insert({ ...owner, tool, status, position: nextPosition++ })
          else if (storedConnection.status !== status)
            await tx.mutate.toolConnections.update({ ...owner, tool, status })
        }
      },
      toolCatalog: async () => toolCatalog,
    },
  }
  return { run: (work) => work(unitOfWork) }
}
