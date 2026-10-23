import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import type { ZeroContext } from '@spyria/db/zero-queries'
import { credentialId, type MemberId, type WorkspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import { DisplayName } from '../domain/display-name.ts'
import { NotOwnProfile } from '../domain/errors.ts'
import { createZeroTransactor, memberContext } from '../integrations/zero-transactor.ts'
import { releaseWorkspaceConnections } from '../operations/release-workspace-connections.ts'
import { removeLlmCredential } from '../operations/remove-llm-credential.ts'
import { removeMemberProfile } from '../operations/remove-member-profile.ts'
import { renameMember } from '../operations/rename-member.ts'

const workspaceArguments = z.object({ workspaceId: z.string().check(z.minLength(1)) })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new NotOwnProfile()
  return { transactor: createZeroTransactor(tx, context) }
}

const contextMember = (context: ZeroContext) => ({ workspaceId: context.workspaceId, memberId: context.userId })

export const profileMutators = defineMutators({
  profile: {
    renameMember: defineMutator(
      z.extend(workspaceArguments, { name: z.pipe(z.string(), z.transform(DisplayName)) }),
      ({ tx, ctx, args }) => renameMember(dependenciesOf(tx, ctx, args), { ...args, ...contextMember(ctx) }),
    ),
    removeLlmCredential: defineMutator(
      z.extend(workspaceArguments, {
        credentialId: z.pipe(z.string().check(z.minLength(1)), z.transform(credentialId)),
      }),
      ({ tx, ctx, args }) => removeLlmCredential(dependenciesOf(tx, ctx, args), { ...args, ...contextMember(ctx) }),
    ),
  },
})

export const removeMemberProfileOnServer = async (tx: Transaction, workspaceId: WorkspaceId, memberId: MemberId) => {
  if (tx.location === 'server')
    await removeMemberProfile(
      { transactor: createZeroTransactor(tx, memberContext(workspaceId, memberId)) },
      { workspaceId, memberId },
    )
}

export const releaseWorkspaceConnectionsOnServer = async (
  tx: Transaction,
  workspaceId: WorkspaceId,
  actorId: MemberId,
) => {
  if (tx.location === 'server')
    await releaseWorkspaceConnections(
      { transactor: createZeroTransactor(tx, memberContext(workspaceId, actorId)) },
      { workspaceId },
    )
}
