import type { ChatId, MemberId } from '@spyria/kernel'
import type { UnitOfWork } from '../contracts/transactor.ts'
import { isActiveLoop, memberWroteNoticeOf, memberWroteOutcomeOf, stopped } from '../domain/dev-loop.ts'
import { appendNotice } from './agent-turn.ts'
import { loopOf, saveLoop } from './dev-loop-turns.ts'

export const stopDevLoopForMessage = async (unitOfWork: UnitOfWork, chatId: ChatId, authorId: MemberId) => {
  await unitOfWork.agentTurns.lock(chatId)
  const loop = loopOf(await unitOfWork.messages.devLoopCard(chatId))
  if (!loop || !isActiveLoop(loop.step)) return
  const name = await unitOfWork.members.displayNameOf(authorId)
  await saveLoop(unitOfWork, loop, stopped(loop.step, memberWroteOutcomeOf(name)))
  for (const prompt of await unitOfWork.agentTurns.waitingPrompts(chatId))
    if (prompt.step?.type === 'dev_loop_prompt') await appendNotice(unitOfWork, prompt, memberWroteNoticeOf(name))
}
