import { type CloudflareCall, zoneOf } from './cloudflare.ts'

export const resendApi = 'https://api.resend.com'
const verificationAttempts = 60
const verificationPollMilliseconds = 10_000

type ResendRecord = { record: string; name: string; type: string; value: string; priority?: number; ttl?: string }
type ResendDomain = { id: string; name: string; status: string; records?: ResendRecord[] }

export class ResendRefused extends Error {}

const resendClientOf =
  (apiKey: string, api: string) =>
  async <Result>(method: string, path: string, body?: object): Promise<Result> => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    const answer = (await response.json().catch(() => ({}))) as Result & { message?: string }
    if (!response.ok) throw new ResendRefused(`Resend refused ${method} ${path}: ${answer.message ?? response.status}`)
    return answer
  }

const fullNameOf = (name: string, domain: string) =>
  name === '' || name === '@' ? domain : name.endsWith(`.${domain}`) || name === domain ? name : `${name}.${domain}`

export const setUpResend = async ({
  apiKey,
  hostname,
  cloudflare,
  api = resendApi,
  pollMilliseconds = verificationPollMilliseconds,
}: {
  apiKey: string
  hostname: string
  cloudflare: CloudflareCall
  api?: string
  pollMilliseconds?: number
}) => {
  const resend = resendClientOf(apiKey, api)
  const zone = await zoneOf(cloudflare, hostname)
  const { data: domains } = await resend<{ data: ResendDomain[] }>('GET', '/domains')
  const known = domains.find((domain) => domain.name === zone.name)
  const { id } = known ?? (await resend<ResendDomain>('POST', '/domains', { name: zone.name }))
  const domain = await resend<ResendDomain>('GET', `/domains/${id}`)
  for (const record of domain.records ?? []) {
    const name = fullNameOf(record.name, zone.name)
    const existing = await cloudflare<{ type: string; content: string }[]>(
      'GET',
      `/zones/${zone.id}/dns_records?${new URLSearchParams({ name, type: record.type })}`,
    )
    if (existing.some(({ content }) => content.replace(/^"|"$/g, '') === record.value)) continue
    await cloudflare('POST', `/zones/${zone.id}/dns_records`, {
      type: record.type,
      name,
      content: record.value,
      ttl: 1,
      ...(record.priority !== undefined && { priority: record.priority }),
    })
  }
  await resend('POST', `/domains/${id}/verify`)
  for (let attempt = 1; ; attempt++) {
    const { status } = await resend<ResendDomain>('GET', `/domains/${id}`)
    if (status === 'verified') break
    if (attempt === verificationAttempts || (status === 'failed' && attempt > 1))
      throw new ResendRefused(
        `Resend did not verify ${zone.name} (${status}): check its DNS records, then run spyria setup again`,
      )
    await Bun.sleep(pollMilliseconds)
  }
  const keyName = `Spyria on ${hostname}`
  const { data: keys } = await resend<{ data: { id: string; name: string }[] }>('GET', '/api-keys')
  for (const replaced of keys.filter((key) => key.name === keyName)) await resend('DELETE', `/api-keys/${replaced.id}`)
  const { token } = await resend<{ token: string }>('POST', '/api-keys', {
    name: keyName,
    permission: 'sending_access',
    domain_id: id,
  })
  return {
    smtpUrl: `smtps://resend:${encodeURIComponent(token)}@smtp.resend.com:465`,
    mailFrom: `Spyria <spyria@${zone.name}>`,
  }
}
