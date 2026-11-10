import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { useEffect, useSyncExternalStore } from 'react'
import type { WorkspaceRead } from '../domain/workspace.ts'
import { getDevWorkspace } from '../queries/get-dev-workspace.ts'
import { usePanelCommands, useWorkspaceReadings } from './providers.tsx'

export const useWorkspaceReading = (workspaceId: WorkspaceId, chatId: ChatId, read: WorkspaceRead, path = '') => {
  const { refreshKey } = useQuery(getDevWorkspace, workspaceId, chatId)
  const { readWorkspace } = usePanelCommands()
  const readings = useWorkspaceReadings()
  const key = JSON.stringify([workspaceId, chatId, read, path])
  const kept = useSyncExternalStore(readings.subscribe, () => readings.keptOf(key))
  const refreshCount = useSyncExternalStore(readings.subscribe, () => readings.refreshCountOf(key))
  const version = `${refreshKey}|${refreshCount}`
  const isCurrent = kept?.version === version
  useEffect(() => {
    if (isCurrent) return
    let isWanted = true
    void readWorkspace({ workspaceId, chatId, read, path }).then(
      (value) => isWanted && readings.keep(key, { version, value }),
      () => isWanted && readings.keep(key, { version, value: { isLive: false } }),
    )
    return () => {
      isWanted = false
    }
  }, [readWorkspace, readings, key, workspaceId, chatId, read, path, version, isCurrent])
  return {
    reading: kept?.value,
    readingVersion: kept?.version,
    isLoading: !isCurrent,
    refresh: () => readings.refresh(key),
  }
}
