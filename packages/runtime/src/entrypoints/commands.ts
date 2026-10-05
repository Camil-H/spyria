import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'

type HostInput = { workspaceId: WorkspaceId; hostId: RuntimeHostId }

export type RuntimeCommands = {
  addHost: (input: { workspaceId: WorkspaceId; name: string }) => Promise<{ id: RuntimeHostId; code: string }>
  renewCode: (input: HostInput) => Promise<string>
  removeHost: (input: HostInput) => Promise<unknown>
}
