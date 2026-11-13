import type { WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, focusRing, smallGhostButtonClass, useGuardedAction } from '@spyria/ui'
import { ChevronDown, Circle } from 'lucide-react'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { isDoneView, type TaskScope, type TaskView } from '../domain/tasks.ts'
import { useOnboardingCommands } from './providers.tsx'
import { taskTextOf } from './task-text.ts'
import { useOnboarding } from './useOnboarding.ts'

const titleByScope: Record<TaskScope, string> = {
  workspace: 'Get your workspace ready',
  member: 'Set up your profile',
}

const storedIsCollapsed = (storageKey: string) => {
  try {
    return localStorage.getItem(storageKey) === 'true'
  } catch {
    return false
  }
}

const useStoredCollapse = (storageKey: string) => {
  const [isCollapsed, setIsCollapsed] = useState(() => storedIsCollapsed(storageKey))
  const toggleCollapsed = () => {
    setIsCollapsed(!isCollapsed)
    try {
      localStorage.setItem(storageKey, String(!isCollapsed))
    } catch {}
  }
  return { isCollapsed, toggleCollapsed }
}

const TaskRow = ({
  workspaceId,
  view,
  onSkip,
  isPending,
}: {
  workspaceId: WorkspaceId
  view: TaskView
  onSkip: () => void
  isPending: boolean
}) => {
  const { title, explanation, page } = taskTextOf(view.task)
  const linkClass = `font-medium underline-offset-2 hover:underline ${focusRing}`
  return (
    <li className="flex items-start gap-3 py-2">
      <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-ink" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>
          <span className="sr-only">To do: </span>
          <Link to={`/w/${workspaceId}/${page}`} className={linkClass}>
            {title}
          </Link>
        </span>
        <span className="text-sm text-muted">{explanation}</span>
      </div>
      <button
        type="button"
        aria-label={`Skip ${title}`}
        disabled={isPending}
        className={smallGhostButtonClass}
        onClick={onSkip}
      >
        Skip
      </button>
    </li>
  )
}

export const ChecklistBlock = ({ workspaceId, scope }: { workspaceId: WorkspaceId; scope: TaskScope }) => {
  const commands = useOnboardingCommands()
  const { tasks } = useOnboarding(workspaceId)
  const { isCollapsed, toggleCollapsed } = useStoredCollapse(`spyria.onboarding-collapsed.${scope}.${workspaceId}`)
  const { errorMessage, isPending, run } = useGuardedAction()
  const headingId = useId()
  const listId = useId()
  const shownTasks = tasks.filter((view) => view.scope === scope)
  const leftTasks = shownTasks.filter((view) => !isDoneView(view))
  if (leftTasks.length === 0) return null
  const title = titleByScope[scope]
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-callout-edge bg-callout px-4 py-3"
    >
      <h2 id={headingId}>
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-controls={listId}
          className={`flex w-full items-center gap-2 rounded-md text-left ${focusRing}`}
          onClick={toggleCollapsed}
        >
          <span className="flex-1 font-semibold">{title}</span>
          <span className="text-sm text-muted">
            {shownTasks.filter(isDoneView).length} of {shownTasks.length} done
          </span>
          <ChevronDown aria-hidden className={`size-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
        </button>
      </h2>
      {!isCollapsed && (
        <ul id={listId} className="flex flex-col divide-y divide-callout-edge/40">
          {leftTasks.map((view) => (
            <TaskRow
              key={view.task}
              workspaceId={workspaceId}
              view={view}
              isPending={isPending}
              onSkip={() => run(() => commands.skipTask({ workspaceId, task: view.task }))}
            />
          ))}
        </ul>
      )}
      <ErrorMessage message={errorMessage} />
    </section>
  )
}
