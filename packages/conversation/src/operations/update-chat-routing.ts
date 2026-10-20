import { type ChatId, harnesses, isPickableModel, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { InvalidRouting } from '../domain/errors.ts'
import { type RunsOn, runsOnFieldsOf, runsOnOf, unreachableSessionNoticeOf } from '../domain/session-routing.ts'

type Input = {
  chatId: ChatId
  memberId: MemberId
  sessionModel?: string
  subagentPolicy?: 'auto' | 'same_as_main'
  runsOn?: RunsOn
  adapterModel?: string
  reasoningEffort?: string
}

export const updateChatRouting = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId, sessionModel, subagentPolicy, runsOn, adapterModel, reasoningEffort }: Input,
) =>
  transactor.run(async ({ chats, routing, agentJobs }) => {
    const chat = await chats.get(chatId)
    await requireChatPermission(chats, chatId, memberId, 'session.configure')
    if (chat.type !== 'runtime') throw new InvalidRouting('Only runtime chats have a model')
    if ((sessionModel ?? (chat.localSession ? undefined : reasoningEffort)) !== undefined && chat.harness)
      throw new InvalidRouting(
        `This session runs ${harnesses[chat.harness].name}; its model is chosen by ${harnesses[chat.harness].name}`,
      )
    if (
      (runsOn ?? adapterModel ?? (chat.localSession ? reasoningEffort : undefined)) !== undefined &&
      chat.ownerId !== memberId
    )
      throw new InvalidRouting('Only the owner changes how this session runs')
    if (runsOn !== undefined && (await chats.hasAgentSession(chatId)))
      throw new InvalidRouting('This session has started; where it runs no longer changes')
    if (
      runsOn !== undefined &&
      runsOn !== 'runtime' &&
      !((await chats.localSessionsAllowed()) && (await chats.hasMachine(memberId)))
    )
      throw new InvalidRouting('Sessions on your machine need your machine and the workspace switch on')
    if (adapterModel !== undefined && !chat.localSession)
      throw new InvalidRouting('Only sessions on your machine pick the model of their tool')
    if (sessionModel !== undefined) {
      const reachable = await routing.reachableModels(memberId)
      if (reachable && !isPickableModel(sessionModel, reachable, routing.listedModels()))
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
      ...(subagentPolicy !== undefined && { subagentPolicy }),
      ...(runsOn !== undefined && { ...runsOnFieldsOf(runsOn), model: null }),
      ...(adapterModel !== undefined && { model: adapterModel || null }),
      ...(reasoningEffort !== undefined && { reasoningEffort }),
    })
    if (runsOn !== undefined && runsOn !== runsOnOf(chat)) await chats.dropRuntime(chatId)
    if (runsOn !== undefined && runsOn !== 'runtime') await agentJobs.startSession(chatId)
  })
