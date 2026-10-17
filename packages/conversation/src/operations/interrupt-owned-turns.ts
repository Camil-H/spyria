import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { AgentDependencies } from './agent-turn.ts'
import { interruptAgent } from './stop-agent.ts'

type Input = { workspaceId: WorkspaceId; memberId: MemberId; actorId: MemberId }

export const interruptOwnedTurns = async (
  dependencies: AgentDependencies,
  { workspaceId, memberId, actorId }: Input,
) => {
  const ownedTurns = await dependencies.transactor.run(async ({ agentTurns, chats }) => {
    const turns = await agentTurns.active()
    const owners = await Promise.all(turns.map(async (turn) => (await chats.get(turn.chatId)).ownerId))
    return turns.filter((_, index) => owners[index] === memberId)
  })
  for (const { chatId, promptId } of ownedTurns)
    await interruptAgent(dependencies, { workspaceId, chatId, promptId, memberId: actorId })
}
