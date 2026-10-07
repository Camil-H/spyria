import { memberNamesIn, type Snapshot } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import { monthsNewestFirst, sumUsage, type UsageMonth, type WorkspaceUsage } from '../domain/usage.ts'

const groupedBy = <Row, Key>(rows: readonly Row[], keyOf: (row: Row) => Key) => {
  const rowsByKey = new Map<Key, Row[]>()
  for (const row of rows) rowsByKey.set(keyOf(row), [...(rowsByKey.get(keyOf(row)) ?? []), row])
  return [...rowsByKey]
}

export const getWorkspaceUsage =
  (workspaceId: WorkspaceId, month: UsageMonth) =>
  (snapshot: Snapshot): WorkspaceUsage => {
    const entries = snapshot.usageEntries.filter((entry) => entry.workspaceId === workspaceId)
    const entriesOfMonth = entries.filter((entry) => entry.month === month)
    const nameOf = memberNamesIn(snapshot, workspaceId)
    const chatById = new Map(
      snapshot.chats.filter((chat) => chat.workspaceId === workspaceId).map((chat) => [chat.id, chat]),
    )
    const projectNameById = new Map(
      snapshot.projects
        .filter((project) => project.workspaceId === workspaceId)
        .map((project) => [project.id, project.name]),
    )
    return {
      months: monthsNewestFirst(entries),
      total: sumUsage(entriesOfMonth),
      byMember: groupedBy(entriesOfMonth, (entry) => entry.memberId)
        .map(([memberId, rows]) => ({ memberId, name: nameOf(memberId), ...sumUsage(rows) }))
        .toSorted((first, second) => first.name.localeCompare(second.name)),
      byProject: groupedBy(entriesOfMonth, (entry) => chatById.get(entry.chatId)?.projectId ?? null)
        .map(([projectId, rows]) => ({
          projectId,
          name: projectId === null ? 'No project' : (projectNameById.get(projectId) ?? 'Unknown'),
          ...sumUsage(rows),
        }))
        .toSorted(
          (first, second) =>
            Number(first.projectId === null) - Number(second.projectId === null) ||
            first.name.localeCompare(second.name),
        ),
    }
  }
