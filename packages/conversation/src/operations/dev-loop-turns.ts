import { type MemberId, type MessageId, systemActor } from '@spyria/kernel'
import type { UnitOfWork } from '../contracts/transactor.ts'
import { type DevLoopStep, devLoopJobTypes, isActiveLoop, memberWroteOutcomeOf, stopped } from '../domain/dev-loop.ts'
import type { Message } from '../domain/message.ts'

export type Loop = { card: Message; step: DevLoopStep; ownerId: MemberId }

export const devLoopActor = 'dev_loop'

export const loopOf = (card: Message | undefined): Loop | undefined =>
  card?.step?.type === 'dev_loop' && card.authorId ? { card, step: card.step, ownerId: card.authorId } : undefined

export const loopOfPrompt = async ({ messages }: UnitOfWork, prompt: Message) => {
  if (prompt.step?.type === 'dev_loop_prompt') return loopOf(await messages.find(prompt.step.loopId))
  const loop = loopOf(await messages.devLoopCard(prompt.chatId))
  return loop?.step.startPromptId === prompt.id ? loop : undefined
}

export const saveLoop = (unitOfWork: UnitOfWork, { card, ownerId }: Loop, step: DevLoopStep) =>
  unitOfWork.messages.record({
    type: 'message.step_changed',
    actor: systemActor(devLoopActor, ownerId),
    message: { ...card, step },
  })

export const afterLoopTurn = async (unitOfWork: UnitOfWork, promptId: MessageId) => {
  const loop = await loopOfPrompt(unitOfWork, await unitOfWork.messages.get(promptId))
  if (!loop || !isActiveLoop(loop.step) || loop.step.lastPromptId !== promptId) return
  const waiting = (await unitOfWork.agentTurns.waitingPrompts(loop.card.chatId)).find(
    (prompt) => prompt.step?.type !== 'dev_loop_prompt' && prompt.authorId,
  )
  if (waiting?.authorId)
    return saveLoop(
      unitOfWork,
      loop,
      stopped(loop.step, memberWroteOutcomeOf(await unitOfWork.members.displayNameOf(waiting.authorId))),
    )
  await unitOfWork.devLoop.enqueue(devLoopJobTypes.afterTurn, loop.card.id)
}
