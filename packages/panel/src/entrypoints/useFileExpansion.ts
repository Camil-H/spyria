import { useState } from 'react'
import { type ChangeGroup, isCollapsedByDefault } from '../domain/workspace.ts'

const fileKeyOf = (groupKey: string, path: string) => `${groupKey}\n${path}`

export const useFileExpansion = (changeGroups: readonly ChangeGroup[]) => {
  const [collapsedChoice, setCollapsedChoice] = useState<boolean>()
  const [openedFiles, setOpenedFiles] = useState<ReadonlyMap<string, boolean>>(new Map())
  const isCollapsed = collapsedChoice ?? isCollapsedByDefault(changeGroups.flatMap(({ changes }) => changes))
  const isExpanded = (groupKey: string, path: string) => openedFiles.get(fileKeyOf(groupKey, path)) ?? !isCollapsed
  const toggle = (groupKey: string, path: string) =>
    setOpenedFiles(new Map(openedFiles).set(fileKeyOf(groupKey, path), !isExpanded(groupKey, path)))
  const isAnyExpanded = changeGroups.some(({ sha, title, changes }) =>
    changes.some(({ path }) => isExpanded(sha ?? title, path)),
  )
  const setAllCollapsed = (isAllCollapsed: boolean) => {
    setCollapsedChoice(isAllCollapsed)
    setOpenedFiles(new Map())
  }
  return { isExpanded, toggle, isAnyExpanded, setAllCollapsed }
}
