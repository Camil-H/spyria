import { useQuery } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '../../app/session.tsx'
import { hasLlmCredential } from '../queries/has-llm-credential.ts'

export const useHasLlmCredential = (workspaceId: WorkspaceId) =>
  useQuery(hasLlmCredential(workspaceId, useSession().memberId))
