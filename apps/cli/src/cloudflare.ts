export const cloudflareApi = 'https://api.cloudflare.com/client/v4'

type Envelope<Result> = { success: boolean; errors?: { message: string }[]; result: Result }
type Zone = { id: string; name: string; account: { id: string } }
type Tunnel = { id: string; name: string }
type DnsRecord = { id: string; type: string; content: string }

const tunnelTarget = '.cfargotunnel.com'
const isTunnelRecord = ({ type, content }: DnsRecord) => type === 'CNAME' && content.endsWith(tunnelTarget)

export class CloudflareRefused extends Error {}

export type CloudflareCall = <Result>(method: string, path: string, body?: object) => Promise<Result>

export const cloudflareClientOf =
  (apiToken: string, api = cloudflareApi): CloudflareCall =>
  async <Result>(method: string, path: string, body?: object) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    const envelope = (await response.json().catch(() => ({ success: false }))) as Envelope<Result>
    if (!response.ok || !envelope.success)
      throw new CloudflareRefused(
        `Cloudflare refused ${method} ${path.split('?')[0]}: ${envelope.errors?.map((error) => error.message).join('; ') || response.status}`,
      )
    return envelope.result
  }

const zoneCandidatesOf = (hostname: string) => {
  const labels = hostname.split('.')
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'))
}

export const zoneOf = async (call: CloudflareCall, hostname: string) => {
  for (const candidate of zoneCandidatesOf(hostname)) {
    const [zone] = await call<Zone[]>('GET', `/zones?${new URLSearchParams({ name: candidate })}`)
    if (zone) return zone
  }
  throw new CloudflareRefused(`No Cloudflare zone this token can edit holds ${hostname}`)
}

export const createTunnel = async ({
  apiToken,
  hostname,
  tunnelName,
  api = cloudflareApi,
}: {
  apiToken: string
  hostname: string
  tunnelName: string
  api?: string
}) => {
  const call = cloudflareClientOf(apiToken, api)
  const zone = await zoneOf(call, hostname)
  const recordsAtHostname = await call<DnsRecord[]>(
    'GET',
    `/zones/${zone.id}/dns_records?${new URLSearchParams({ name: hostname })}`,
  )
  const otherRecordTypes = [
    ...new Set(recordsAtHostname.filter((record) => !isTunnelRecord(record)).map(({ type }) => type)),
  ]
  if (otherRecordTypes.length > 0)
    throw new CloudflareRefused(
      `${hostname} already has DNS records (${otherRecordTypes.join(', ')}): delete them in Cloudflare, or choose another hostname`,
    )
  const accountPath = `/accounts/${zone.account.id}/cfd_tunnel`
  const [existing] = await call<Tunnel[]>(
    'GET',
    `${accountPath}?${new URLSearchParams({ name: tunnelName, is_deleted: 'false' })}`,
  )
  const tunnel = existing ?? (await call<Tunnel>('POST', accountPath, { name: tunnelName, config_src: 'cloudflare' }))
  await call('PUT', `${accountPath}/${tunnel.id}/configurations`, {
    config: { ingress: [{ hostname, service: 'http://server:3000' }, { service: 'http_status:404' }] },
  })
  const record = { type: 'CNAME', name: hostname, content: `${tunnel.id}${tunnelTarget}`, proxied: true }
  const [tunnelRecord] = recordsAtHostname
  if (tunnelRecord) await call('PUT', `/zones/${zone.id}/dns_records/${tunnelRecord.id}`, record)
  else await call('POST', `/zones/${zone.id}/dns_records`, record)
  const token = await call<string>('GET', `${accountPath}/${tunnel.id}/token`)
  return { tunnelId: tunnel.id, token, origin: `https://${hostname}` }
}
