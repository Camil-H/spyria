import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { useEffect, useState } from 'react'
import type { WorkspaceRead, WorkspaceReading } from '../domain/workspace.ts'
import { getDevWorkspace } from '../queries/get-dev-workspace.ts'
import { usePanelCommands } from './providers.tsx'

export const useWorkspaceReading = (workspaceId: WorkspaceId, chatId: ChatId, read: WorkspaceRead, path = '') => {
  const { refreshKey } = useQuery(getDevWorkspace, workspaceId, chatId)
  const { readWorkspace } = usePanelCommands()
  const [refreshCount, setRefreshCount] = useState(0)
  const [reading, setReading] = useState<{ version: string; value: WorkspaceReading }>()
  const version = `${refreshKey}|${refreshCount}`
  useEffect(() => {
    let isCurrent = true
    void readWorkspace({ workspaceId, chatId, read, path }).then(
      (value) => isCurrent && setReading({ version, value }),
      () => isCurrent && setReading({ version, value: { isLive: false } }),
    )
    return () => {
      isCurrent = false
    }
  }, [readWorkspace, workspaceId, chatId, read, path, version])
  return { reading: reading?.value, refresh: () => setRefreshCount(refreshCount + 1) }
}
