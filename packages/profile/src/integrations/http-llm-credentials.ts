import type { WorkspaceId } from '@hq/kernel'
import { ProfileError } from '../domain/errors.ts'
import type { Secret } from '../domain/secret.ts'

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
    if (response.status === 400) {
      const { error, message } = (await response.json()) as { error: string; message: string }
      throw new ProfileError(error, message)
    }
    if (!response.ok) throw new Error(`Adding an LLM credential was refused with ${response.status}`)
  }
