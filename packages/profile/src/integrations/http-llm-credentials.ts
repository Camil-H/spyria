import type { WorkspaceId } from '@spyria/kernel'
import type { Secret } from '../domain/secret.ts'
import { throwOnRefusal } from './http-refusal.ts'

export const llmCredentialsPath = '/api/llm-credentials'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body: string) => Promise<Response>

export const createHttpLlmCredentialAdder =
  (postAsMember: PostAsMember) =>
  async ({ workspaceId, provider, secret }: { workspaceId: WorkspaceId; provider: string; secret: Secret }) => {
    const response = await postAsMember(
      workspaceId,
      llmCredentialsPath,
      JSON.stringify({ provider, secret: secret.reveal() }),
    )
    await throwOnRefusal(response, 'Adding an LLM credential')
  }
