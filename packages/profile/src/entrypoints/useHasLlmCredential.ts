import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { hasLlmCredential } from '../queries/has-llm-credential.ts'

export const useHasLlmCredential = (workspaceId: WorkspaceId) =>
  useQuery(hasLlmCredential(workspaceId, useSession().memberId))
