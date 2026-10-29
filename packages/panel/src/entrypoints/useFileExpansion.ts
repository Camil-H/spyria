import { useState } from 'react'
import { type ChangeGroup, isCollapsedByDefault } from '../domain/workspace.ts'

export const groupKeyOf = ({ sha, title }: Pick<ChangeGroup, 'sha' | 'title'>) => sha ?? title
const fileKeyOf = (groupKey: string, path: string) => `${groupKey}\n${path}`

export const useFileExpansion = (changeGroups: readonly ChangeGroup[]) => {
  const [collapsedChoice, setCollapsedChoice] = useState<boolean>()
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(new Set())
  const isCollapsed = collapsedChoice ?? isCollapsedByDefault(changeGroups.flatMap(({ changes }) => changes))
  const isExpanded = (groupKey: string, path: string) => toggledFiles.has(fileKeyOf(groupKey, path)) === isCollapsed
  const toggle = (groupKey: string, path: string) => {
    const toggled = new Set(toggledFiles)
    const fileKey = fileKeyOf(groupKey, path)
    if (!toggled.delete(fileKey)) toggled.add(fileKey)
    setToggledFiles(toggled)
  }
  const isAnyExpanded = changeGroups.some((group) =>
    group.changes.some(({ path }) => isExpanded(groupKeyOf(group), path)),
  )
  const setAllCollapsed = (isAllCollapsed: boolean) => {
    setCollapsedChoice(isAllCollapsed)
    setToggledFiles(new Set())
  }
  return { isExpanded, toggle, isAnyExpanded, setAllCollapsed }
}
