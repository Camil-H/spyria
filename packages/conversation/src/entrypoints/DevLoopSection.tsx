import { useQuery } from '@spyria/db/react'
import { type DevLoopSettings, defaultDevLoopSettings, devLoopRange, type WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  LabelledSection,
  labelClass,
  Switch,
  useGuardedAction,
} from '@spyria/ui'
import { useEffect, useState } from 'react'
import { devLoopSettingsOf } from '../queries/get-dev-loop-settings.ts'
import { useConversationCommands } from './providers.tsx'

type RoundField = keyof typeof devLoopRange
type Draft = Record<RoundField | 'costLimitDollars', string>

const roundFields: { key: RoundField; label: string }[] = [
  { key: 'checkRounds', label: 'Times the agent fixes failing checks' },
  { key: 'reviewRounds', label: 'Review rounds (0 turns the review off)' },
  { key: 'ciRounds', label: 'Times the agent fixes failing CI (0 does not wait for CI)' },
  { key: 'timeLimitMinutes', label: 'Time limit of a loop, in minutes' },
]

const draftOf = (settings: DevLoopSettings): Draft => ({
  checkRounds: String(settings.checkRounds),
  reviewRounds: String(settings.reviewRounds),
  ciRounds: String(settings.ciRounds),
  timeLimitMinutes: String(settings.timeLimitMinutes),
  costLimitDollars: settings.costLimitMicros === null ? '' : String(settings.costLimitMicros / 1_000_000),
})

const settingsOf = (draft: Draft): DevLoopSettings => ({
  checkRounds: Number(draft.checkRounds),
  reviewRounds: Number(draft.reviewRounds),
  ciRounds: Number(draft.ciRounds),
  timeLimitMinutes: Number(draft.timeLimitMinutes),
  costLimitMicros: draft.costLimitDollars.trim() === '' ? null : Math.round(Number(draft.costLimitDollars) * 1_000_000),
})

export const DevLoopSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useConversationCommands()
  const settings = useQuery(devLoopSettingsOf, workspaceId)
  const [draft, setDraft] = useState(draftOf(settings ?? defaultDevLoopSettings))
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => setDraft(draftOf(settings ?? defaultDevLoopSettings)), [settings])
  const save = (next: DevLoopSettings | null) => run(() => commands.setDevLoop({ workspaceId, settings: next }))
  return (
    <LabelledSection title="Dev loop">
      <p className="text-sm text-muted">
        When the agent of a dev chat says its work is done, Spyria runs the repository's checks from
        .spyria/dev-loop.json, has the diff reviewed, pushes and opens the pull request, then waits for CI. Each failure
        goes back to the agent, within the limits below; then the chat owner takes over.
      </p>
      <Switch
        label="Agents in dev chats check their own work"
        isOn={settings !== null}
        onToggle={() => save(settings === null ? defaultDevLoopSettings : null)}
      />
      {settings !== null && (
        <form
          className="flex max-w-md flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            save(settingsOf(draft))
          }}
        >
          {roundFields.map(({ key, label }) => (
            <label key={key} className={labelClass}>
              {label}
              <input
                type="number"
                min={devLoopRange[key].minimum}
                max={devLoopRange[key].maximum}
                step={1}
                className={fieldClass}
                value={draft[key]}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
              />
            </label>
          ))}
          <label className={labelClass}>
            Cost limit of a loop, in dollars (sessions on an API key only)
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="No limit"
              className={fieldClass}
              value={draft.costLimitDollars}
              onChange={(event) => setDraft({ ...draft, costLimitDollars: event.target.value })}
            />
          </label>
          <button type="submit" className={`self-start ${buttonClass}`} disabled={isPending}>
            Save
          </button>
        </form>
      )}
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
