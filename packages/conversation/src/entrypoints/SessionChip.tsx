import { type ChatId, modelNameOf, rereadDollarsOf, type WorkspaceId } from '@hq/kernel'
import { buttonClass, fieldClass, focusRing, formatCost, ghostButtonClass, labelClass } from '@hq/ui'
import { useEffect, useRef, useState } from 'react'
import { chipLabelOf, type Harness, type RunsOn, runsOnNames } from '../domain/session-routing.ts'
import type { Conversation } from '../queries/get-conversation.ts'
import type { ChatRoutingRead } from './endpoints.ts'
import { useConversationCommands } from './providers.tsx'

type Policy = 'auto' | 'same_as_main'
type Fields = {
  sessionModel?: string
  defaultModel?: string
  subagentPolicy?: Policy
  runsOn?: RunsOn
  acpModel?: string
}

const refreshMilliseconds = 2000
const microsPerDollar = 1_000_000

export const SessionChip = (chip: {
  workspaceId: WorkspaceId
  chatId: ChatId
  model: string | null
  reasoningEffort: string | null
  defaultModel: string | null
  subagentPolicy: Policy
  harness: Harness | null
  localSession: boolean
  runsOn: RunsOn | null
  isOwner: boolean
  runsOnChoices: Conversation['runsOnChoices']
}) => {
  const {
    workspaceId,
    chatId,
    model,
    defaultModel,
    subagentPolicy,
    harness,
    localSession,
    runsOn,
    isOwner,
    runsOnChoices,
  } = chip
  const commands = useConversationCommands()
  const [isOpen, setIsOpen] = useState(false)
  const chipRef = useRef<HTMLDivElement>(null)
  const [routing, setRouting] = useState<ChatRoutingRead>()
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  useEffect(() => {
    commands.chatRouting({ workspaceId, chatId }).then(setRouting, () => {})
  }, [commands, workspaceId, chatId])
  useEffect(() => {
    if (!isOpen) return
    const load = () => commands.chatRouting({ workspaceId, chatId }).then(setRouting, () => {})
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && setIsOpen(false)
    const closeOnOutsideClick = (event: PointerEvent) =>
      chipRef.current?.contains(event.target as Node) || setIsOpen(false)
    void load()
    const timer = setInterval(load, refreshMilliseconds)
    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('pointerdown', closeOnOutsideClick)
    }
  }, [isOpen, commands, workspaceId, chatId])
  const nameOf = (id: string) => routing?.modelNames[id] ?? modelNameOf(id)
  const update = (fields: Fields) => commands.updateChatRouting({ workspaceId, chatId, ...fields })
  const reachableIds = routing?.reachableModels.map(({ id }) => id) ?? []
  const optionsWith = (current: string | null) =>
    [...(current && !reachableIds.includes(current) ? [current] : []), ...reachableIds].map((id) => (
      <option key={id} value={id}>
        {nameOf(id)}
      </option>
    ))
  const runsOnOptions = [...(runsOn && !runsOnChoices?.includes(runsOn) ? [runsOn] : []), ...(runsOnChoices ?? [])]
  const adapterModels = routing?.adapterModels.available ?? []
  const adapterModel = model ?? routing?.adapterModels.currentModelId ?? ''
  const adapterNameOf = (id: string) =>
    adapterModels.find((candidate) => candidate.id === id)?.name ?? (id || 'Default')
  const estimate = pendingModel
    ? rereadDollarsOf(
        routing?.reachableModels.find(({ id }) => id === pendingModel),
        routing?.contextTokens ?? null,
      )
    : undefined
  return (
    <div ref={chipRef} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className={`max-w-full truncate rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:text-ink ${focusRing}`}
      >
        {chipLabelOf(chip, nameOf, adapterNameOf)}
      </button>
      {isOpen && (
        <div
          role="dialog"
          aria-label="Session"
          className="absolute bottom-full left-0 z-50 mb-1 flex w-80 flex-col gap-3 rounded-lg border border-line bg-raised p-3 text-sm shadow-lg"
        >
          {runsOn === null ? null : runsOnOptions.length > 1 ? (
            <label className={labelClass}>
              Runs on
              <select
                className={fieldClass}
                value={runsOn}
                onChange={(event) => update({ runsOn: event.target.value as RunsOn })}
              >
                {runsOnOptions.map((option) => (
                  <option key={option} value={option}>
                    {runsOnNames[option]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>Runs on {runsOnNames[runsOn]}</p>
          )}
          {localSession && isOwner && (
            <label className={labelClass}>
              Model
              <select
                className={fieldClass}
                value={adapterModel}
                onChange={(event) => update({ acpModel: event.target.value })}
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
                {estimate === undefined
                  ? 'cost unknown'
                  : `about ${formatCost(Math.max(1, estimate * microsPerDollar))}`}
                )
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
            <>
              <label className={labelClass}>
                Default model
                <select
                  className={fieldClass}
                  value={defaultModel ?? ''}
                  onChange={(event) => update({ defaultModel: event.target.value })}
                >
                  {defaultModel === null && <option value="">None</option>}
                  {optionsWith(defaultModel)}
                </select>
              </label>
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
