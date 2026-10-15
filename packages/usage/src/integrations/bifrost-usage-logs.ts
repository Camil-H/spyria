import { chatId, memberId, type WorkspaceId } from '@hq/kernel'
import type { GatewayUsageLogs } from '../contracts/usage-sync.ts'
import type { ModelCall } from '../domain/usage.ts'

type LogRow = {
  id: string
  timestamp: string
  provider: string
  model: string
  status: string
  cost?: number
  token_usage?: { prompt_tokens?: number; completion_tokens?: number }
  metadata?: Record<string, string> | null
}

const pageSize = 500

export const createBifrostUsageLogs = ({
  url,
  adminUser,
  adminPassword,
  labels = {},
  timeoutMilliseconds = 10_000,
}: {
  url: string
  adminUser: string
  adminPassword: string
  labels?: Record<string, string>
  timeoutMilliseconds?: number
}): GatewayUsageLogs => {
  const authorization = `Basic ${btoa(`${adminUser}:${adminPassword}`)}`
  const page = async (workspaceId: WorkspaceId, since: Date, offset: number) => {
    const query = new URLSearchParams({
      start_time: since.toISOString(),
      sort_by: 'timestamp',
      order: 'asc',
      limit: String(pageSize),
      offset: String(offset),
      ...Object.fromEntries(
        Object.entries({ ...labels, workspace: workspaceId }).map(([name, value]) => [`metadata_${name}`, value]),
      ),
    })
    const response = await fetch(`${url}/api/logs?${query}`, {
      headers: { authorization },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    })
    if (!response.ok) throw new Error(`The gateway answered GET /api/logs with ${response.status}`)
    return ((await response.json()) as { logs: LogRow[] | null }).logs ?? []
  }
  return {
    since: async (workspaceId, since) => {
      const rows: LogRow[] = []
      for (let offset = 0; ; offset += pageSize) {
        const fetched = await page(workspaceId, since, offset)
        rows.push(...fetched)
        if (fetched.length < pageSize) break
      }
      const pending = rows.filter((row) => row.status !== 'success' && row.status !== 'error')
      return {
        calls: rows.flatMap(({ id, timestamp, provider, model, status, cost, token_usage, metadata }): ModelCall[] =>
          metadata?.workspace === workspaceId &&
          metadata.chat &&
          metadata.prompter &&
          (status === 'success' || status === 'error')
            ? [
                {
                  id,
                  chatId: chatId(metadata.chat),
                  prompterId: memberId(metadata.prompter),
                  ownerId: metadata.owner ? memberId(metadata.owner) : null,
                  model,
                  provider,
                  inputTokens: token_usage?.prompt_tokens ?? 0,
                  outputTokens: token_usage?.completion_tokens ?? 0,
                  costMicros: Math.round((cost ?? 0) * 1_000_000),
                  status,
                  role: metadata.role ?? null,
                  calledAt: new Date(timestamp),
                },
              ]
            : [],
        ),
        oldestPendingAt: pending[0] && new Date(pending[0].timestamp),
      }
    },
  }
}
