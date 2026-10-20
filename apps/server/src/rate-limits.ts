import { DomainError, log } from '@spyria/kernel'
import type { Context, MiddlewareHandler } from 'hono'

type Budget = { count: number; perMilliseconds: number; per: 'address' | 'workspace' | 'member' }
type Requester = { address?: string; workspaceId?: string; userId?: string }
type RequestIp = { requestIP?: (request: Request) => { address: string } | null }
export type TrustedProxy = 'cloudflare' | undefined

const minute = 60_000
const hour = 60 * minute
const maxBuckets = 10_000

export const rateBudgets = {
  emailRouting: { count: 10, perMilliseconds: minute, per: 'address' },
  signInCallback: { count: 30, perMilliseconds: minute, per: 'address' },
  firstWorkspace: { count: 5, perMilliseconds: hour, per: 'address' },
  verificationLink: { count: 20, perMilliseconds: minute, per: 'address' },
  hostConnection: { count: 10, perMilliseconds: minute, per: 'address' },
  githubWebhooks: { count: 600, perMilliseconds: minute, per: 'address' },
  verificationEmails: { count: 3, perMilliseconds: hour, per: 'workspace' },
  invites: { count: 50, perMilliseconds: hour, per: 'workspace' },
  prompts: { count: 30, perMilliseconds: minute, per: 'member' },
  runtimeCreation: { count: 10, perMilliseconds: minute, per: 'member' },
} as const satisfies Record<string, Budget>
export type RateLimitName = keyof typeof rateBudgets
export type RateBudgets = Record<RateLimitName, Budget>

const limitByMutation: Record<string, RateLimitName> = {
  'workspace.inviteMember': 'invites',
  'conversation.sendMessage': 'prompts',
  'conversation.retryAgent': 'prompts',
  'conversation.startRuntimeFromMessage': 'runtimeCreation',
  'conversation.forkChat': 'runtimeCreation',
}

export const limitOfMutation = (name: string, args: unknown): RateLimitName | undefined =>
  limitByMutation[name] ??
  (name === 'workspace.createChat' && (args as { type?: string } | undefined)?.type === 'runtime'
    ? 'runtimeCreation'
    : undefined)

export class RateLimited extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super('rate_limited', `Too many requests: try again in ${retryAfterSeconds} seconds.`)
  }
}

export const createRateLimiter = (budgets: RateBudgets, now = Date.now) => {
  const buckets = new Map<string, { tokens: number; refilledAt: number; perMilliseconds: number }>()
  const forgetRefilled = (at: number) => {
    for (const [bucketKey, bucket] of buckets)
      if (at - bucket.refilledAt >= bucket.perMilliseconds) buckets.delete(bucketKey)
  }
  return (name: RateLimitName, { address = '', workspaceId = '', userId = '' }: Requester) => {
    const { count, perMilliseconds, per } = budgets[name]
    const at = now()
    if (buckets.size >= maxBuckets) forgetRefilled(at)
    const bucketKey = `${name} ${per === 'address' ? address : per === 'workspace' ? workspaceId : `${workspaceId} ${userId}`}`
    const bucket = buckets.get(bucketKey) ?? { tokens: count, refilledAt: at, perMilliseconds }
    bucket.tokens = Math.min(count, bucket.tokens + ((at - bucket.refilledAt) * count) / perMilliseconds)
    bucket.refilledAt = at
    buckets.set(bucketKey, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return
    }
    log.warn({
      event: 'rate_limit.hit',
      body: 'A rate limit was hit',
      attributes: {
        'rate_limit.name': name,
        ...(per !== 'address' && { 'workspace.id': workspaceId }),
        ...(per === 'member' && { 'user.id': userId }),
      },
    })
    throw new RateLimited(Math.ceil(((1 - bucket.tokens) * perMilliseconds) / count / 1000))
  }
}
export type RateLimiter = ReturnType<typeof createRateLimiter>

export const clientAddressOf = (request: Request, socketAddress: string | undefined, trustedProxy: TrustedProxy) =>
  (trustedProxy === 'cloudflare' && request.headers.get('cf-connecting-ip')) || socketAddress || ''

export const rateLimitedBy =
  (limit: RateLimiter, trustedProxy: TrustedProxy) =>
  (name: RateLimitName): MiddlewareHandler =>
  async (context: Context, next) => {
    const socketAddress = (context.env as RequestIp | undefined)?.requestIP?.(context.req.raw)?.address
    try {
      limit(name, {
        address: clientAddressOf(context.req.raw, socketAddress, trustedProxy),
        ...(context.get('zeroContext') as Requester | undefined),
      })
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error
      const headers = { 'retry-after': String(error.retryAfterSeconds) }
      return context.req.path.startsWith('/api/')
        ? context.json({ error: error.code, message: error.message }, 429, headers)
        : context.text(error.message, 429, headers)
    }
    await next()
  }
