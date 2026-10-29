import type { WorkspaceId } from '@spyria/kernel'
import { focusRing, iconButtonClass } from '@spyria/ui'
import { ListChecks } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { NavLink } from 'react-router'
import { isSettled, nextTaskOf, type OnboardingTask } from '../domain/tasks.ts'
import { useOnboardingCommands } from './providers.tsx'
import { taskTextOf } from './task-text.ts'
import { useOnboarding } from './useOnboarding.ts'

const useRecordCompletedTasks = (workspaceId: WorkspaceId, tasksToRecord: readonly OnboardingTask[]) => {
  const commands = useOnboardingCommands()
  const [attemptedTasks] = useState(() => new Set<string>())
  useEffect(() => {
    const pendingTasks = tasksToRecord.filter((task) => !attemptedTasks.has(`${workspaceId}/${task}`))
    if (pendingTasks.length === 0) return
    for (const task of pendingTasks) attemptedTasks.add(`${workspaceId}/${task}`)
    commands.recordCompletedTasks({ workspaceId }).catch(() => undefined)
  }, [commands, workspaceId, tasksToRecord, attemptedTasks])
}

export const SidebarChecklistLink = ({
  workspaceId,
  isCollapsed,
  usesSingleSignOn,
}: {
  workspaceId: WorkspaceId
  isCollapsed: boolean
  usesSingleSignOn: boolean
}) => {
  const { tasks, tasksToRecord, domain } = useOnboarding(workspaceId, usesSingleSignOn)
  useRecordCompletedTasks(workspaceId, tasksToRecord)
  const nextTaskId = useId()
  const settledCount = tasks.filter(isSettled).length
  if (settledCount === tasks.length) return null
  const nextTask = nextTaskOf(tasks)
  const nextText = nextTask && taskTextOf(nextTask, domain)
  const target = `/w/${workspaceId}/${nextText ? `${nextText.page}${nextText.section ? `#${nextText.section}` : ''}` : 'settings'}`
  const label = `Get started: ${settledCount} of ${tasks.length} done`
  if (isCollapsed)
    return (
      <NavLink to={target} aria-label={label} title={label} className={`${iconButtonClass} self-start`}>
        <ListChecks aria-hidden size={18} />
      </NavLink>
    )
  return (
    <NavLink
      to={target}
      aria-label={label}
      aria-describedby={nextText && nextTaskId}
      className={`flex flex-col gap-0.5 rounded-md border border-callout-edge bg-callout px-2 py-1.5 text-sm hover:bg-callout-hover ${focusRing}`}
    >
      <span className="flex items-center gap-2 font-medium">
        <ListChecks aria-hidden className="size-4" />
        <span className="flex-1">Get started</span>
        <span className="text-xs text-muted">
          {settledCount}/{tasks.length}
        </span>
      </span>
      {nextText && (
        <span id={nextTaskId} className="truncate pl-6 text-xs text-muted">
          Next: {nextText.title}
        </span>
      )}
    </NavLink>
  )
}
