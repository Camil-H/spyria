import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { WorkspaceRead, WorkspaceReading } from '../domain/workspace.ts'
import { getDevWorkspace } from '../queries/get-dev-workspace.ts'
import { usePanelCommands, useWorkspaceReadings } from './providers.tsx'

const failedReading: WorkspaceReading = { isLive: false }

export const useWorkspaceReading = (workspaceId: WorkspaceId, chatId: ChatId, read: WorkspaceRead, path = '') => {
  const { refreshKey } = useQuery(getDevWorkspace, workspaceId, chatId)
  const { readWorkspace } = usePanelCommands()
  const readings = useWorkspaceReadings()
  const key = JSON.stringify([workspaceId, chatId, read, path])
  const kept = useSyncExternalStore(readings.subscribe, () => readings.keptOf(key))
  const refreshCount = useSyncExternalStore(readings.subscribe, () => readings.refreshCountOf(key))
  const [failedRead, setFailedRead] = useState<string>()
  const version = `${refreshKey}|${refreshCount}`
  const isFailed = failedRead === `${key}|${version}`
  const isCurrent = isFailed || kept?.version === version
  useEffect(() => readings.watch(key), [readings, key])
  useEffect(() => {
    if (isCurrent) return
    let isWanted = true
    void readWorkspace({ workspaceId, chatId, read, path }).then(
      (value) => isWanted && readings.keep(key, { version, value }),
      () => isWanted && setFailedRead(`${key}|${version}`),
    )
    return () => {
      isWanted = false
    }
  }, [readWorkspace, readings, key, workspaceId, chatId, read, path, version, isCurrent])
  return {
    reading: isFailed ? failedReading : kept?.value,
    readingVersion: isFailed ? version : kept?.version,
    isLoading: !isCurrent,
    refresh: () => readings.refresh(key),
  }
}
