import type { ZeroContext } from '@hq/db/zero-queries'
import { credentialId } from '@hq/kernel'
import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import { DisplayName } from '../domain/display-name.ts'
import { NotOwnProfile } from '../domain/errors.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { connectTool } from '../operations/connect-tool.ts'
import { disconnectTool } from '../operations/disconnect-tool.ts'
import { removeLlmCredential } from '../operations/remove-llm-credential.ts'
import { renameMember } from '../operations/rename-member.ts'

const workspaceArguments = z.object({ workspaceId: z.string().check(z.minLength(1)) })
const toolArguments = z.extend(workspaceArguments, { tool: z.string() })

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
    connectTool: defineMutator(toolArguments, ({ tx, ctx, args }) =>
      connectTool(dependenciesOf(tx, ctx, args), { ...args, ...contextMember(ctx) }),
    ),
    disconnectTool: defineMutator(toolArguments, ({ tx, ctx, args }) =>
      disconnectTool(dependenciesOf(tx, ctx, args), { ...args, ...contextMember(ctx) }),
    ),
  },
})
