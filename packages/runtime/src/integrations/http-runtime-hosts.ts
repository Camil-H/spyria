import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'
import { RuntimeError } from '../domain/errors.ts'

export const runtimeHostsPath = '/api/runtime-hosts'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>

const resultOf = async (response: Response) => {
  if (response.ok) return (await response.json()) as { id: RuntimeHostId; code: string }
  const { error, message } = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
  throw new RuntimeError(error ?? 'internal', message ?? `The request was refused with ${response.status}`)
}

export const createHttpRuntimeHostCommands = (postAsMember: PostAsMember) => ({
  addHost: async ({ workspaceId, name }: { workspaceId: WorkspaceId; name: string }) =>
    resultOf(await postAsMember(workspaceId, runtimeHostsPath, JSON.stringify({ name }))),
  renewCode: async ({ workspaceId, hostId }: { workspaceId: WorkspaceId; hostId: RuntimeHostId }) =>
    (await resultOf(await postAsMember(workspaceId, `${runtimeHostsPath}/${hostId}/code`))).code,
})
