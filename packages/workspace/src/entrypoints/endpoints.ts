import type { Transact, ZeroContext } from '@spyria/db/zero-queries'
import { projectId } from '@spyria/kernel'
import type { GitHubRepositories } from '../contracts/repositories.ts'
import { type DevChatInput, existingBranchOf, repositoryNameOf } from '../domain/github.ts'
import { Name } from '../domain/name.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { createChat } from '../operations/create-chat.ts'

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

export const createDevChatFromRequest = async (
  transact: Transact,
  context: ZeroContext,
  body: unknown,
  github: GitHubRepositories,
) => {
  const input = (body ?? {}) as Partial<DevChatInput>
  const name = Name(textOf(input.name))
  const repository = repositoryNameOf(textOf(input.repository))
  const baseBranch = existingBranchOf(repository, await github.branches(repository), textOf(input.baseBranch))
  const id = crypto.randomUUID()
  await transact((tx) =>
    createChat(
      { transactor: createZeroTransactor(tx, context) },
      {
        id,
        workspaceId: context.workspaceId,
        ownerId: context.userId,
        type: 'runtime',
        name,
        projectId: input.projectId ? projectId(textOf(input.projectId)) : null,
        repository: { fullName: repository, baseBranch },
      },
    ),
  )
  return { chatId: id }
}
