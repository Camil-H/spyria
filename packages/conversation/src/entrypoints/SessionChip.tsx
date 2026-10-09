import { type ChatId, modelNameOf, rereadDollarsOf, type WorkspaceId } from '@hq/kernel'
import { buttonClass, fieldClass, focusRing, formatCost, formatTokens, ghostButtonClass, labelClass } from '@hq/ui'
import { useEffect, useState } from 'react'
import { claudeCode } from '../domain/session-routing.ts'
import type { ChatRoutingRead } from './endpoints.ts'
import { useConversationCommands } from './providers.tsx'

type Policy = 'auto' | 'same_as_main'
type Fields = { sessionModel?: string; defaultModel?: string; subagentPolicy?: Policy }

const policyNames: Record<Policy, string> = { auto: 'auto', same_as_main: 'same as main' }
const refreshMilliseconds = 2000
const microsPerDollar = 1_000_000
const cellClass = 'px-2 py-1 text-right'

export const SessionChip = ({
  workspaceId,
  chatId,
  model,
  reasoningEffort,
  defaultModel,
  subagentPolicy,
  harness,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  model: string | null
  reasoningEffort: string | null
  defaultModel: string | null
  subagentPolicy: Policy
  harness: 'claude-code' | null
}) => {
  const commands = useConversationCommands()
  const [isOpen, setIsOpen] = useState(false)
  const [routing, setRouting] = useState<ChatRoutingRead>()
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  useEffect(() => {
    commands.chatRouting({ workspaceId, chatId }).then(setRouting, () => {})
  }, [commands, workspaceId, chatId])
  useEffect(() => {
    if (!isOpen) return
    const load = () => commands.chatRouting({ workspaceId, chatId }).then(setRouting, () => {})
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && setIsOpen(false)
    void load()
    const timer = setInterval(load, refreshMilliseconds)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      clearInterval(timer)
      document.removeEventListener('keydown', closeOnEscape)
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
  const estimate = pendingModel
    ? rereadDollarsOf(
        routing?.reachableModels.find(({ id }) => id === pendingModel),
        routing?.contextTokens ?? null,
      )
    : undefined
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className={`max-w-full truncate rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:text-ink ${focusRing}`}
      >
        {harness && model
          ? `${claudeCode.name} · ${nameOf(model)}`
          : model
            ? `${nameOf(model)}${reasoningEffort ? ` (${reasoningEffort})` : ''} · ${policyNames[subagentPolicy]}`
            : 'Model chosen at first prompt'}
      </button>
      {isOpen && (
        <div
          role="dialog"
          aria-label="Session"
          className="absolute top-full right-0 z-50 mt-1 flex w-80 flex-col gap-3 rounded-lg border border-line bg-raised p-3 text-sm shadow-lg"
        >
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
          <table aria-label="Models used in this chat" className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                {['Model', 'Calls', 'Tokens', 'Cost'].map((title, index) => (
                  <th key={title} scope="col" className={index === 0 ? 'px-2 py-1 text-left' : cellClass}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {routing?.modelsUsed.map((used) => (
                <tr key={used.model} className="border-t border-line">
                  <th scope="row" className="px-2 py-1 text-left font-normal">
                    {nameOf(used.model)}
                  </th>
                  <td className={cellClass}>{used.calls}</td>
                  <td className={cellClass}>{formatTokens(used.tokens)}</td>
                  <td className={cellClass}>{formatCost(used.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
