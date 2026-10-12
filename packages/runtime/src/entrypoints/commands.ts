import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'

type HostInput = { workspaceId: WorkspaceId; hostId: RuntimeHostId }

export type RuntimeCommands = {
  addHost: (input: { workspaceId: WorkspaceId; name: string }) => Promise<{ id: RuntimeHostId; code: string }>
  addMachine: (input: { workspaceId: WorkspaceId }) => Promise<{ id: RuntimeHostId; code: string }>
  countMachines: (input: { workspaceId: WorkspaceId }) => Promise<number>
  renewCode: (input: HostInput) => Promise<string>
  removeHost: (input: HostInput) => Promise<unknown>
  setLocalSessions: (input: { workspaceId: WorkspaceId; isOn: boolean }) => Promise<unknown>
}
