import { type ChatId, modelNameOf, type WorkspaceId } from '@hq/kernel'
import { focusRing } from '@hq/ui'
import { ChevronDown } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { chipLabelOf, type Harness, type RunsOn, runsOnNames } from '../domain/session-routing.ts'
import type { ChatRoutingRead } from '../queries/get-chat-routing.ts'
import type { Conversation } from '../queries/get-conversation.ts'
import { useConversationCommands } from './providers.tsx'

type Policy = 'auto' | 'same_as_main'

const refreshMilliseconds = 2000
const SessionDialog = lazy(() => import('./SessionDialog.tsx'))
const barChipClass = `flex max-w-full items-center gap-1 truncate rounded-md px-2 py-1 text-xs text-muted enabled:hover:bg-selected enabled:hover:text-ink ${focusRing}`

export const RunsOnChip = ({
  workspaceId,
  chatId,
  runsOn,
  runsOnChoices,
  status,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  runsOn: RunsOn
  runsOnChoices: Conversation['runsOnChoices']
  status: ReactNode
}) => {
  const commands = useConversationCommands()
  const options = [...(runsOnChoices?.includes(runsOn) ? [] : [runsOn]), ...(runsOnChoices ?? [])]
  const isLocked = options.length < 2
  return (
    <div className="flex min-w-0 items-center gap-1.5 pr-2">
      <div className="relative flex min-w-0 items-center">
        <select
          aria-label="Runs on"
          disabled={isLocked}
          value={runsOn}
          onChange={(event) =>
            commands.updateChatRouting({ workspaceId, chatId, runsOn: event.target.value as RunsOn })
          }
          className={`${barChipClass} bg-transparent ${isLocked ? 'bg-none' : 'pr-7'}`}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {isLocked && option !== 'runtime' ? 'Local' : runsOnNames[option]}
            </option>
          ))}
        </select>
      </div>
      <span aria-hidden className="text-xs text-muted">
        ·
      </span>
      {status}
    </div>
  )
}

export const PlanModeToggle = ({
  workspaceId,
  chatId,
  isPlanning,
  hasSession,
  mayChange,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  isPlanning: boolean
  hasSession: boolean
  mayChange: boolean
}) => {
  const commands = useConversationCommands()
  return (
    <fieldset
      aria-label="Mode"
      title={hasSession ? undefined : 'Plan and Auto are available once the agent session has started'}
      disabled={!hasSession || !mayChange}
      className="flex items-center text-xs"
    >
      <div className="flex rounded-md border border-line p-0.5 in-disabled:opacity-40">
        {[
          { label: 'Plan', enabled: true },
          { label: 'Auto', enabled: false },
        ].map(({ label, enabled }) => (
          <label
            key={label}
            className="relative cursor-pointer rounded px-2 py-0.5 text-muted has-checked:bg-selected has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-focus in-disabled:cursor-not-allowed"
          >
            <input
              type="radio"
              name={`mode-${chatId}`}
              className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              checked={isPlanning === enabled}
              onChange={() => commands.setPlanMode({ workspaceId, chatId, enabled })}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export const SessionChip = (chip: {
  workspaceId: WorkspaceId
  chatId: ChatId
  model: string | null
  reasoningEffort: string | null
  subagentPolicy: Policy
  harness: Harness | null
  localSession: boolean
  isOwner: boolean
  canConfigure: boolean
}) => {
  const { workspaceId, chatId } = chip
  const commands = useConversationCommands()
  const [isOpen, setIsOpen] = useState(false)
  const chipRef = useRef<HTMLDivElement>(null)
  const [routing, setRouting] = useState<ChatRoutingRead>()
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
  const adapterModels = routing?.adapterModels.available ?? []
  const adapterNameOf = (id: string) =>
    adapterModels.find((candidate) => candidate.id === id)?.name ?? (id || 'Default')
  const label = chipLabelOf(chip, nameOf, adapterNameOf)
  return (
    <div ref={chipRef} className="relative min-w-0">
      <button
        type="button"
        aria-label={`Model: ${label}`}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className={barChipClass}
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden size={12} className="shrink-0" />
      </button>
      {isOpen && (
        <div
          role="dialog"
          aria-label="Session"
          className="absolute bottom-full left-0 z-50 mb-1 w-80 rounded-lg border border-line bg-raised p-3 text-sm shadow-lg"
        >
          <fieldset disabled={!chip.canConfigure} className="flex min-w-0 flex-col gap-3">
            <Suspense fallback={null}>
              <SessionDialog chip={chip} routing={routing} nameOf={nameOf} adapterNameOf={adapterNameOf} />
            </Suspense>
          </fieldset>
        </div>
      )}
    </div>
  )
}
