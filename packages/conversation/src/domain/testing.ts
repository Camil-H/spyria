import type { AgentEvent } from './agent-events.ts'

export const acpUpdate = (
  seq: number,
  update: Record<string, unknown>,
  completed = true,
  timestamp = '2026-10-12T17:56:00.000Z',
): AgentEvent => ({
  id: `conversation-1:${seq}`,
  kind: 'ACPUpdate',
  timestamp,
  seq,
  completed,
  update,
})
