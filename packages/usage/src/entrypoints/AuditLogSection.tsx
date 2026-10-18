import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  useGuardedAction,
} from '@hq/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type SubmitEvent, useEffect, useState } from 'react'
import { type AuditEntry, auditGroups, retentionLabelOf } from '../domain/audit.ts'
import { listAuditPeople } from '../queries/list-audit-people.ts'
import { useUsageCommands } from './providers.tsx'

type Filters = { person: string; group: string; from: string; to: string }

const noFilters: Filters = { person: '', group: '', from: '', to: '' }
const dayMilliseconds = 24 * 3_600_000

const searchOf = ({ person, group, from, to }: Filters, cursor?: string) =>
  Object.fromEntries(
    Object.entries({
      person,
      group,
      from: from && new Date(`${from}T00:00:00`).toISOString(),
      to: to && new Date(new Date(`${to}T00:00:00`).getTime() + dayMilliseconds).toISOString(),
      cursor: cursor ?? '',
    }).filter(([, value]) => value !== ''),
  )

const RetentionForm = ({ workspaceId, onSaved }: { workspaceId: WorkspaceId; onSaved: () => void }) => {
  const commands = useUsageCommands()
  const [savedDays, setSavedDays] = useState<number | null | undefined>(undefined)
  const [isForever, setIsForever] = useState(true)
  const [days, setDays] = useState('30')
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.readAuditRetention({ workspaceId }).then((retentionDays) => {
      setSavedDays(retentionDays)
      setIsForever(retentionDays === null)
      if (retentionDays !== null) setDays(String(retentionDays))
    })
  }, [commands, workspaceId])
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (
      await run(async () =>
        setSavedDays(
          await commands.saveAuditRetention({ workspaceId, retentionDays: isForever ? null : Number(days) }),
        ),
      )
    )
      onSaved()
  }
  if (savedDays === undefined) return <p className="text-sm text-muted">Loading…</p>
  return (
    <form aria-label="Retention" onSubmit={save} className="flex flex-wrap items-end gap-2">
      <label className={labelClass}>
        Keep audit records
        <select
          className={fieldClass}
          value={isForever ? 'forever' : 'days'}
          onChange={(event) => setIsForever(event.target.value === 'forever')}
        >
          <option value="forever">Forever</option>
          <option value="days">For a number of days</option>
        </select>
      </label>
      {!isForever && (
        <label className={labelClass}>
          Days
          <input
            type="number"
            min={1}
            max={36500}
            className={`${fieldClass} w-24`}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </label>
      )}
      <button type="submit" className={buttonClass} disabled={isPending}>
        Save
      </button>
      <p className="basis-full text-sm text-muted">Audit records are kept: {retentionLabelOf(savedDays)}</p>
      <div className="basis-full">
        <ErrorMessage message={errorMessage} />
      </div>
    </form>
  )
}

const AuditEntryItem = ({ entry }: { entry: AuditEntry }) => {
  const [isOpen, setIsOpen] = useState(false)
  const Chevron = isOpen ? ChevronDown : ChevronRight
  return (
    <li className="flex flex-col gap-1 border-b border-line py-2 text-sm">
      <button
        type="button"
        aria-expanded={isOpen}
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-left"
        onClick={() => setIsOpen(!isOpen)}
      >
        <Chevron aria-hidden className="size-4 self-center text-muted" />
        <time dateTime={entry.at} className="text-muted">
          {new Date(entry.at).toLocaleString()}
        </time>
        <span className="font-medium">{entry.person}</span>
        <span>{entry.action}</span>
        <span className="text-muted">{entry.target}</span>
      </button>
      {isOpen && (
        <dl aria-label="Details" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pl-6 text-muted">
          {entry.details.map(({ label, value }) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd className="break-all text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

export const AuditLogSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useUsageCommands()
  const people = useQuery(listAuditPeople(workspaceId))
  const [filters, setFilters] = useState(noFilters)
  const [entries, setEntries] = useState<readonly AuditEntry[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    let isCurrent = true
    commands.readAuditPage({ workspaceId, search: searchOf(filters) }).then(
      (page) => {
        if (!isCurrent) return
        setEntries(page.entries)
        setNextCursor(page.nextCursor)
        setLoadError(null)
      },
      (error: Error) => isCurrent && setLoadError(error.message),
    )
    return () => {
      isCurrent = false
    }
  }, [commands, workspaceId, filters])
  const loadMore = (cursor: string) =>
    run(async () => {
      const page = await commands.readAuditPage({ workspaceId, search: searchOf(filters, cursor) })
      setEntries([...(entries ?? []), ...page.entries])
      setNextCursor(page.nextCursor)
    })
  const exportCsv = () =>
    run(async () => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(await commands.exportAuditCsv({ workspaceId, search: searchOf(filters) }))
      link.download = 'audit-log.csv'
      link.click()
      URL.revokeObjectURL(link.href)
    })
  const filterField = (name: keyof Filters) => ({
    className: fieldClass,
    value: filters[name],
    onChange: (event: { target: { value: string } }) => setFilters({ ...filters, [name]: event.target.value }),
  })
  return (
    <LabelledSection title="Audit log">
      <RetentionForm workspaceId={workspaceId} onSaved={() => setFilters({ ...filters })} />
      <fieldset aria-label="Filters" className="flex flex-wrap items-end gap-2">
        <label className={labelClass}>
          Person
          <select {...filterField('person')}>
            <option value="">Everyone</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Type
          <select {...filterField('group')}>
            <option value="">All types</option>
            {auditGroups.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          From
          <input type="date" {...filterField('from')} />
        </label>
        <label className={labelClass}>
          To
          <input type="date" {...filterField('to')} />
        </label>
        <button type="button" className={`ml-auto ${ghostButtonClass}`} disabled={isPending} onClick={exportCsv}>
          Export CSV
        </button>
      </fieldset>
      <ErrorMessage message={errorMessage ?? loadError} />
      {entries === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted">No audit records</p>
      ) : (
        <ul aria-label="Audit records" className="flex flex-col">
          {entries.map((entry) => (
            <AuditEntryItem key={entry.key} entry={entry} />
          ))}
        </ul>
      )}
      {nextCursor && (
        <button
          type="button"
          className={`self-start ${ghostButtonClass}`}
          disabled={isPending}
          onClick={() => loadMore(nextCursor)}
        >
          Load more
        </button>
      )}
    </LabelledSection>
  )
}
