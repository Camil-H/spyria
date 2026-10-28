import type { HarnessId } from '@spyria/kernel'
import { type ChatId, rereadDollarsOf, type WorkspaceId } from '@spyria/kernel'
import { buttonClass, fieldClass, formatCost, ghostButtonClass, labelClass } from '@spyria/ui'
import { useId, useState } from 'react'
import { piThoughtLevels } from '../domain/session-routing.ts'
import type { ChatRoutingRead } from '../queries/get-chat-routing.ts'
import { useConversationCommands } from './providers.tsx'

type Policy = 'auto' | 'same_as_main'
type Fields = {
  sessionModel?: string
  subagentPolicy?: Policy
  adapterModel?: string
  reasoningEffort?: string
}

const microsPerDollar = 1_000_000
const searchedModelsShown = 50

const SessionDialog = ({
  chip: { workspaceId, chatId, model, reasoningEffort, subagentPolicy, harness, localSession, isOwner, contextTokens },
  routing,
  nameOf,
  adapterNameOf,
}: {
  chip: {
    workspaceId: WorkspaceId
    chatId: ChatId
    model: string | null
    reasoningEffort: string | null
    subagentPolicy: Policy
    harness: HarnessId | null
    localSession: boolean
    isOwner: boolean
    contextTokens: number | null
  }
  routing: ChatRoutingRead | undefined
  nameOf: (id: string) => string
  adapterNameOf: (id: string) => string
}) => {
  const commands = useConversationCommands()
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const mainModelId = useId()
  const update = (fields: Fields) => commands.updateChatRouting({ workspaceId, chatId, ...fields })
  const reachableIds = routing?.reachableModels.map(({ id }) => id) ?? []
  const wanted = modelSearch.trim().toLowerCase()
  const searchedIds = wanted
    ? (routing?.listedModelIds ?? []).filter((id) => id.toLowerCase().includes(wanted)).slice(0, searchedModelsShown)
    : []
  const optionsWith = (...current: (string | null)[]) =>
    [
      ...new Set([
        ...current.flatMap((id) => (id && !reachableIds.includes(id) ? id : [])),
        ...reachableIds,
        ...searchedIds,
      ]),
    ].map((id) => (
      <option key={id} value={id}>
        {nameOf(id)}
      </option>
    ))
  const adapterModels = routing?.adapterModels.available ?? []
  const adapterModel = model ?? routing?.adapterModels.currentModelId ?? ''
  const adapterEfforts = routing?.adapterEfforts.available ?? []
  const adapterEffort = reasoningEffort ?? routing?.adapterEfforts.current ?? ''
  const estimate = pendingModel
    ? rereadDollarsOf(
        routing?.reachableModels.find(({ id }) => id === pendingModel),
        contextTokens,
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
      {localSession && isOwner && adapterEfforts.length > 0 && (
        <label className={labelClass}>
          Effort
          <select
            className={fieldClass}
            value={adapterEffort}
            onChange={(event) => update({ reasoningEffort: event.target.value })}
          >
            {[
              ...(adapterEfforts.some((level) => level.id === adapterEffort)
                ? []
                : [{ id: adapterEffort, name: adapterEffort }]),
              ...adapterEfforts,
            ].map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {model && !harness && (
        <div className={labelClass}>
          <label htmlFor={mainModelId}>Main model</label>
          <input
            type="search"
            aria-label="Search all models"
            placeholder="Search all models"
            className={fieldClass}
            value={modelSearch}
            onChange={(event) => setModelSearch(event.target.value)}
          />
          <select
            id={mainModelId}
            className={fieldClass}
            value={pendingModel ?? model}
            onChange={(event) => setPendingModel(event.target.value === model ? null : event.target.value)}
          >
            {optionsWith(model, pendingModel)}
          </select>
        </div>
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
      {model && !harness && (
        <label className={labelClass}>
          Effort
          <select
            className={fieldClass}
            value={reasoningEffort ?? 'medium'}
            onChange={(event) => update({ reasoningEffort: event.target.value })}
          >
            {[...new Set([reasoningEffort ?? 'medium', ...piThoughtLevels])].map((level) => (
              <option key={level} value={level}>
                {level === 'xhigh' ? 'Extra high' : level[0]?.toUpperCase() + level.slice(1)}
              </option>
            ))}
          </select>
        </label>
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
