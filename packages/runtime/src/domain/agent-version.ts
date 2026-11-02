export const minimumAgentProtocol = 1

export type AgentReadiness = { agentVersion: string | null; protocolVersion: number }

export const readinessOf = (body: string): AgentReadiness => {
  try {
    const answer: { agentVersion?: unknown; protocolVersion?: unknown } = JSON.parse(body)
    return {
      agentVersion: typeof answer.agentVersion === 'string' ? answer.agentVersion : null,
      protocolVersion: typeof answer.protocolVersion === 'number' ? answer.protocolVersion : 0,
    }
  } catch {
    return { agentVersion: null, protocolVersion: 0 }
  }
}

export const isAgentOutOfDate = ({ protocolVersion }: AgentReadiness) => protocolVersion < minimumAgentProtocol
