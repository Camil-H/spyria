import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { hasLlmCredential } from '../queries/has-llm-credential.ts'

export const useHasLlmCredential = (workspaceId: WorkspaceId) =>
  useQuery(hasLlmCredential(workspaceId, useSession().memberId))
