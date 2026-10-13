import { type ChatId, chatModelsOf, type MemberId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { InvalidRouting } from '../domain/errors.ts'
import {
  harnesses,
  type RunsOn,
  runsOnFieldsOf,
  runsOnOf,
  unreachableSessionNoticeOf,
} from '../domain/session-routing.ts'

type Input = {
  chatId: ChatId
  memberId: MemberId
  sessionModel?: string
  defaultModel?: string
  subagentPolicy?: 'auto' | 'same_as_main'
  runsOn?: RunsOn
  acpModel?: string
}

export const updateChatRouting = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId, sessionModel, defaultModel, subagentPolicy, runsOn, acpModel }: Input,
) =>
  transactor.run(async ({ chats, routing }) => {
    const chat = await chats.get(chatId)
    if (chat.type !== 'runtime') throw new InvalidRouting('Only runtime chats have a model')
    if (sessionModel !== undefined && chat.harness)
      throw new InvalidRouting(
        `This session runs ${harnesses[chat.harness].name}; its model is chosen by ${harnesses[chat.harness].name}`,
      )
    if ((runsOn ?? acpModel) !== undefined && chat.ownerId !== memberId)
      throw new InvalidRouting('Only the owner changes how this session runs')
    if (runsOn !== undefined && (await chats.hasAgentSession(chatId)))
      throw new InvalidRouting('This session has started; where it runs no longer changes')
    if (
      runsOn !== undefined &&
      runsOn !== 'runtime' &&
      !((await chats.localSessionsAllowed()) && (await chats.hasMachine(memberId)))
    )
      throw new InvalidRouting('Sessions on your machine need your machine and the workspace switch on')
    if (acpModel !== undefined && !chat.localSession)
      throw new InvalidRouting('Only sessions on your machine pick the model of their tool')
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
      ...(runsOn !== undefined && { ...runsOnFieldsOf(runsOn), model: null }),
      ...(acpModel !== undefined && { model: acpModel || null }),
    })
    if (runsOn !== undefined && runsOn !== runsOnOf(chat)) await chats.dropRuntime(chatId)
  })
