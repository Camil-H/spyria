import { chatId, memberId, type WorkspaceId, withRetries } from '@spyria/kernel'
import type { GatewayUsageLogs } from '../contracts/usage-sync.ts'
import { logsPageCursor, type ModelCall } from '../domain/usage.ts'

const largestGatewayPage = 1000

type LogRow = {
  id: string
  timestamp: string
  provider: string
  model: string
  status: string
  cost?: number
  token_usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  }
  metadata?: Record<string, string> | null
}

export const createBifrostUsageLogs = ({
  url,
  adminUser,
  adminPassword,
  labels = {},
  timeoutMilliseconds = 10_000,
  pageSize = 500,
}: {
  url: string
  adminUser: string
  adminPassword: string
  labels?: Record<string, string>
  timeoutMilliseconds?: number
  pageSize?: number
}): GatewayUsageLogs => {
  const authorization = `Basic ${btoa(`${adminUser}:${adminPassword}`)}`
  const page = async (
    workspaceId: WorkspaceId,
    { from, until, limit, offset = 0 }: { from: Date; until?: string; limit: number; offset?: number },
  ) => {
    const query = new URLSearchParams({
      start_time: from.toISOString(),
      ...(until && { end_time: until }),
      sort_by: 'timestamp',
      order: 'asc',
      limit: String(limit),
      offset: String(offset),
      ...Object.fromEntries(
        Object.entries({ ...labels, workspace: workspaceId }).map(([name, value]) => [`metadata_${name}`, value]),
      ),
    })
    const response = await withRetries(
      (signal) => fetch(`${url}/api/logs?${query}`, { headers: { authorization }, signal }),
      {
        timeoutMilliseconds,
      },
    )
    if (!response.ok) throw new Error(`The gateway answered GET /api/logs with ${response.status}`)
    return ((await response.json()) as { logs: LogRow[] | null }).logs ?? []
  }
  const wholeMillisecond = async (workspaceId: WorkspaceId, millisecond: Date) => {
    const until = `${millisecond.toISOString().slice(0, -1)}999Z`
    const rows: LogRow[] = []
    for (let offset = 0; ; offset += largestGatewayPage) {
      const rowsAtOffset = await page(workspaceId, { from: millisecond, until, limit: largestGatewayPage, offset })
      rows.push(...rowsAtOffset)
      if (rowsAtOffset.length < largestGatewayPage) return rows
    }
  }
  return {
    since: async (workspaceId, since) => {
      const firstPage = await page(workspaceId, { from: since, limit: pageSize })
      const lastRow = firstPage.length === pageSize ? firstPage.at(-1) : undefined
      const cursor = logsPageCursor(since, lastRow && new Date(lastRow.timestamp))
      const rows = cursor.readWholeMillisecond ? await wholeMillisecond(workspaceId, since) : firstPage
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
                  cacheReadTokens: token_usage?.prompt_tokens_details?.cached_tokens ?? 0,
                  cacheWriteTokens: token_usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
                  costMicros: Math.round((cost ?? 0) * 1_000_000),
                  status,
                  role: metadata.role ?? null,
                  turnId: metadata.turn || null,
                  sessionId: metadata.session || null,
                  calledAt: new Date(timestamp),
                },
              ]
            : [],
        ),
        oldestPendingAt: pending[0] && new Date(pending[0].timestamp),
        nextPageFrom: cursor.nextPageFrom,
      }
    },
  }
}
