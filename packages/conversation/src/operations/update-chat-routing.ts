import { type ChatId, chatModelsOf, type MemberId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { InvalidRouting } from '../domain/errors.ts'
import { unreachableSessionNoticeOf } from '../domain/session-routing.ts'

type Input = {
  chatId: ChatId
  memberId: MemberId
  sessionModel?: string
  defaultModel?: string
  subagentPolicy?: 'auto' | 'same_as_main'
}

export const updateChatRouting = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId, sessionModel, defaultModel, subagentPolicy }: Input,
) =>
  transactor.run(async ({ chats, routing }) => {
    if ((await chats.get(chatId)).type !== 'runtime') throw new InvalidRouting('Only runtime chats have a model')
    const reachable =
      sessionModel === undefined && defaultModel === undefined ? undefined : await routing.reachableModels(memberId)
    const isReachable = (model: string) => !reachable || chatModelsOf(reachable).some(({ id }) => id === model)
    if (defaultModel !== undefined && !isReachable(defaultModel))
      throw new InvalidRouting(`Unknown model ${defaultModel}`)
    if (sessionModel !== undefined) {
      if (!isReachable(sessionModel)) throw new InvalidRouting(unreachableSessionNoticeOf(sessionModel))
      await routing.record({
        chatId,
        conversationId: null,
        role: 'manual',
        memberId,
        inputsDigest: null,
        classifierOutput: null,
        model: sessionModel,
        reason: 'manual switch',
        costMicros: 0,
      })
    }
    await routing.update(chatId, {
      ...(sessionModel !== undefined && { model: sessionModel }),
      ...(defaultModel !== undefined && { defaultModel }),
      ...(subagentPolicy !== undefined && { subagentPolicy }),
    })
  })
