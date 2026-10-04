import type { ZeroContext } from '@hq/db/zero-queries'
import { credentialId } from '@hq/kernel'
import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero'
import { z } from 'zod'
import { DisplayName } from '../domain/display-name.ts'
import { NotOwnProfile } from '../domain/errors.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { connectTool } from '../operations/connect-tool.ts'
import { disconnectTool } from '../operations/disconnect-tool.ts'
import { removeLlmCredential } from '../operations/remove-llm-credential.ts'
import { renameMember } from '../operations/rename-member.ts'

const workspaceArguments = z.object({ workspaceId: z.string().min(1) })
const toolArguments = workspaceArguments.extend({ tool: z.string() })

const dependenciesOf = (tx: Transaction, context: ZeroContext, args: { workspaceId: string }) => {
  if (args.workspaceId !== context.workspaceId) throw new NotOwnProfile()
  return { transactor: createZeroTransactor(tx, context) }
}

const contextMember = (context: ZeroContext) => ({ workspaceId: context.workspaceId, memberId: context.userId })

export const profileMutators = defineMutators({
  profile: {
    renameMember: defineMutator(
      workspaceArguments.extend({ name: z.string().transform(DisplayName) }),
      ({ tx, ctx, args }) => renameMember(dependenciesOf(tx, ctx, args), { ...contextMember(ctx), name: args.name }),
    ),
    removeLlmCredential: defineMutator(
      workspaceArguments.extend({ credentialId: z.string().min(1).transform(credentialId) }),
      ({ tx, ctx, args }) =>
        removeLlmCredential(dependenciesOf(tx, ctx, args), { ...contextMember(ctx), credentialId: args.credentialId }),
    ),
    connectTool: defineMutator(toolArguments, ({ tx, ctx, args }) =>
      connectTool(dependenciesOf(tx, ctx, args), { ...contextMember(ctx), tool: args.tool }),
    ),
    disconnectTool: defineMutator(toolArguments, ({ tx, ctx, args }) =>
      disconnectTool(dependenciesOf(tx, ctx, args), { ...contextMember(ctx), tool: args.tool }),
    ),
  },
})
