import { type RuntimeHostId, refusalOf, type WorkspaceId } from '@spyria/kernel'

export const runtimeHostsPath = '/api/runtime-hosts'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>

const resultOf = async <Result = { id: RuntimeHostId; code: string }>(response: Response) => {
  if (response.ok) return (await response.json()) as Result
  throw refusalOf(response.status, await response.json().catch(() => ({})))
}

export const createHttpRuntimeHostCommands = (postAsMember: PostAsMember) => ({
  addHost: async ({ workspaceId, name }: { workspaceId: WorkspaceId; name: string }) =>
    resultOf(await postAsMember(workspaceId, runtimeHostsPath, JSON.stringify({ name }))),
  addMachine: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    resultOf(await postAsMember(workspaceId, runtimeHostsPath, JSON.stringify({ personal: true }))),
  renewCode: async ({ workspaceId, hostId }: { workspaceId: WorkspaceId; hostId: RuntimeHostId }) =>
    (await resultOf(await postAsMember(workspaceId, `${runtimeHostsPath}/${hostId}/code`))).code,
})
