import { type ChatId, catalogModelOf, type MemberId } from '@hq/kernel'
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
    for (const model of [sessionModel, defaultModel])
      if (model !== undefined && !catalogModelOf(model)) throw new InvalidRouting(`Unknown model ${model}`)
    if (sessionModel !== undefined) {
      const reachable = await routing.reachableModels(memberId)
      if (reachable && !reachable.some((model) => model.id === sessionModel))
        throw new InvalidRouting(unreachableSessionNoticeOf(sessionModel))
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
