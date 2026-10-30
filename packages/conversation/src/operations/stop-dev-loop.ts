import type { ChatId, MemberId } from '@spyria/kernel'
import type { UnitOfWork } from '../contracts/transactor.ts'
import { stoppedByNoticeOf } from '../domain/agent-events.ts'
import {
  isActiveLoop,
  loopStoppedNoticeOf,
  memberWroteNoticeOf,
  memberWroteOutcomeOf,
  stopped,
} from '../domain/dev-loop.ts'
import { appendNotice } from './agent-turn.ts'
import { loopOf, saveLoop } from './dev-loop-turns.ts'

const stopDevLoop = async (unitOfWork: UnitOfWork, chatId: ChatId, outcome: string, skippedNotice: string) => {
  await unitOfWork.agentTurns.lock(chatId)
  const loop = loopOf(await unitOfWork.messages.devLoopCard(chatId))
  if (!loop || !isActiveLoop(loop.step)) return
  await saveLoop(unitOfWork, loop, stopped(loop.step, outcome))
  for (const prompt of await unitOfWork.agentTurns.waitingPrompts(chatId))
    if (prompt.step?.type === 'dev_loop_prompt') await appendNotice(unitOfWork, prompt, skippedNotice)
}

export const stopDevLoopForMessage = async (unitOfWork: UnitOfWork, chatId: ChatId, authorId: MemberId) => {
  const name = await unitOfWork.members.displayNameOf(authorId)
  await stopDevLoop(unitOfWork, chatId, memberWroteOutcomeOf(name), memberWroteNoticeOf(name))
}

export const stopDevLoopBy = async (unitOfWork: UnitOfWork, chatId: ChatId, memberId: MemberId) => {
  const name = await unitOfWork.members.displayNameOf(memberId)
  await stopDevLoop(unitOfWork, chatId, stoppedByNoticeOf(name), loopStoppedNoticeOf(name))
}
