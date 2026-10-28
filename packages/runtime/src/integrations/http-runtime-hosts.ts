import { type RuntimeHostId, refusalOf, type WorkspaceId } from '@spyria/kernel'

export const runtimeHostsPath = '/api/runtime-hosts'
export const machinesPath = `${runtimeHostsPath}/machines`

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>

const resultOf = async <Result = { id: RuntimeHostId; code: string }>(response: Response) => {
  if (response.ok) return (await response.json()) as Result
  throw refusalOf(response.status, await response.json().catch(() => ({})))
}

export const createHttpRuntimeHostCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  addHost: async ({ workspaceId, name }: { workspaceId: WorkspaceId; name: string }) =>
    resultOf(await postAsMember(workspaceId, runtimeHostsPath, JSON.stringify({ name }))),
  addMachine: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    resultOf(await postAsMember(workspaceId, runtimeHostsPath, JSON.stringify({ personal: true }))),
  countMachines: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    (await resultOf<{ count: number }>(await getAsMember(workspaceId, machinesPath))).count,
  renewCode: async ({ workspaceId, hostId }: { workspaceId: WorkspaceId; hostId: RuntimeHostId }) =>
    (await resultOf(await postAsMember(workspaceId, `${runtimeHostsPath}/${hostId}/code`))).code,
})
