import { type ChatId, rereadDollarsOf, type WorkspaceId } from '@hq/kernel'
import { buttonClass, fieldClass, formatCost, ghostButtonClass, labelClass } from '@hq/ui'
import { useState } from 'react'
import type { Harness } from '../domain/session-routing.ts'
import type { ChatRoutingRead } from '../queries/get-chat-routing.ts'
import { useConversationCommands } from './providers.tsx'

type Policy = 'auto' | 'same_as_main'
type Fields = {
  sessionModel?: string
  subagentPolicy?: Policy
  adapterModel?: string
}

const microsPerDollar = 1_000_000

const SessionDialog = ({
  chip: { workspaceId, chatId, model, subagentPolicy, harness, localSession, isOwner },
  routing,
  nameOf,
  adapterNameOf,
}: {
  chip: {
    workspaceId: WorkspaceId
    chatId: ChatId
    model: string | null
    subagentPolicy: Policy
    harness: Harness | null
    localSession: boolean
    isOwner: boolean
  }
  routing: ChatRoutingRead | undefined
  nameOf: (id: string) => string
  adapterNameOf: (id: string) => string
}) => {
  const commands = useConversationCommands()
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const update = (fields: Fields) => commands.updateChatRouting({ workspaceId, chatId, ...fields })
  const reachableIds = routing?.reachableModels.map(({ id }) => id) ?? []
  const optionsWith = (current: string | null) =>
    [...(current && !reachableIds.includes(current) ? [current] : []), ...reachableIds].map((id) => (
      <option key={id} value={id}>
        {nameOf(id)}
      </option>
    ))
  const adapterModels = routing?.adapterModels.available ?? []
  const adapterModel = model ?? routing?.adapterModels.currentModelId ?? ''
  const estimate = pendingModel
    ? rereadDollarsOf(
        routing?.reachableModels.find(({ id }) => id === pendingModel),
        routing?.contextTokens ?? null,
      )
    : undefined
  return (
    <>
      {localSession && isOwner && (
        <label className={labelClass}>
          Model
          <select
            className={fieldClass}
            value={adapterModel}
            onChange={(event) => update({ adapterModel: event.target.value })}
          >
            {[
              ...(adapterModels.some((candidate) => candidate.id === adapterModel) ? [] : [adapterModel]),
              ...adapterModels.map((candidate) => candidate.id),
            ].map((id) => (
              <option key={id} value={id}>
                {adapterNameOf(id)}
              </option>
            ))}
          </select>
        </label>
      )}
      {model && !harness && (
        <label className={labelClass}>
          Main model
          <select
            className={fieldClass}
            value={pendingModel ?? model}
            onChange={(event) => setPendingModel(event.target.value === model ? null : event.target.value)}
          >
            {optionsWith(model)}
          </select>
        </label>
      )}
      {pendingModel && (
        <div className="flex flex-col gap-2">
          <p>
            The next reply rereads the whole conversation with {nameOf(pendingModel)} (
            {estimate === undefined ? 'cost unknown' : `about ${formatCost(Math.max(1, estimate * microsPerDollar))}`})
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => update({ sessionModel: pendingModel }).then(() => setPendingModel(null))}
            >
              Switch
            </button>
            <button type="button" className={ghostButtonClass} onClick={() => setPendingModel(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!localSession && (
        <label className={labelClass}>
          Subagents
          <select
            className={fieldClass}
            value={subagentPolicy}
            onChange={(event) => update({ subagentPolicy: event.target.value as Policy })}
          >
            <option value="auto">Auto</option>
            <option value="same_as_main">Same as main</option>
          </select>
        </label>
      )}
    </>
  )
}

export default SessionDialog
