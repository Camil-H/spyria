import { lookup } from 'node:dns/promises'
import { createServer, request } from 'node:http'
import { isIP, connect as openSocket } from 'node:net'

const blockedPage = (host) =>
  `<!doctype html><meta charset="utf-8"><title>Blocked</title><p style="font:16px system-ui;margin:2rem">Your workspace's browser settings block ${host}.</p>`

const ipv4Parts = (address) => address.split('.').map(Number)
const ipv4Number = (address) => ipv4Parts(address).reduce((value, part) => value * 256 + part, 0)
const isInIpv4Range = (address, [base, prefixBits]) => {
  const size = 2 ** (32 - prefixBits)
  return Math.floor(ipv4Number(address) / size) === Math.floor(ipv4Number(base) / size)
}
const internalIpv4Ranges = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
]
const isInternalIpv4 = (address) => internalIpv4Ranges.some((range) => isInIpv4Range(address, range))

const ipv6Groups = (address) => {
  const [head, tail = ''] = address.toLowerCase().split('::')
  const partsOf = (text) => (text ? text.split(':') : [])
  const embedded = (parts) => {
    const last = parts.at(-1)
    if (!last?.includes('.')) return parts
    const [a, b, c, d] = ipv4Parts(last)
    return [...parts.slice(0, -1), ((a << 8) | b).toString(16), ((c << 8) | d).toString(16)]
  }
  const headParts = embedded(partsOf(head))
  const tailParts = embedded(partsOf(tail))
  const missing = address.includes('::') ? 8 - headParts.length - tailParts.length : 0
  return [...headParts, ...Array(missing).fill('0'), ...tailParts].map((group) => Number.parseInt(group, 16) || 0)
}
const ipv4Of = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
const embeddedIpv4Of = (groups) => {
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)
  if (isMapped || isNat64) return ipv4Of(groups[6], groups[7])
  if (groups[0] === 0x2002) return ipv4Of(groups[1], groups[2])
  return undefined
}

export const isInternalAddress = (address) => {
  if (isIP(address) === 4) return isInternalIpv4(address)
  const groups = ipv6Groups(address)
  const embedded = embeddedIpv4Of(groups)
  if (embedded) return isInternalIpv4(embedded)
  const [first] = groups
  return (
    groups.every((group) => group === 0) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  )
}

const hostOf = (host) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
export const isWithinSite = (host, site) => host === site || host.endsWith(`.${site}`)

export const siteVerdictOf = (settings, host) => {
  const name = hostOf(host)
  if (settings.blockedSites.some((site) => isWithinSite(name, site))) return 'blocked_site'
  const isAllowedSite = settings.allowedSites.some((site) => isWithinSite(name, site))
  return settings.allowedSites.length > 0 && !isAllowedSite ? 'site_not_allowed' : 'allowed'
}

export const networkVerdictOf = (settings, host, addresses) => {
  const name = hostOf(host)
  const isAllowedInternal = settings.allowedInternalAddresses.some(
    (allowed) => allowed === name || addresses.includes(allowed),
  )
  const isInternal = addresses.some(isInternalAddress)
  return settings.blockInternalNetworks && isInternal && !isAllowedInternal ? 'internal' : 'allowed'
}

export const blockReasons = {
  blocked_site: 'is a site your workspace blocks',
  site_not_allowed: 'is not among the sites your workspace allows',
  internal: 'is on an internal network your workspace blocks',
}

const addressesOf = async (host) => {
  const name = hostOf(host)
  if (isIP(name)) return [name]
  return (await lookup(name, { all: true, verbatim: true })).map(({ address }) => address)
}

export const createPolicyProxy = ({ settings, onBlocked = () => {} }) => {
  const decide = async (host) => {
    const siteVerdict = siteVerdictOf(settings(), host)
    const addresses = siteVerdict === 'allowed' ? await addressesOf(host) : []
    const verdict = siteVerdict === 'allowed' ? networkVerdictOf(settings(), host, addresses) : siteVerdict
    if (verdict !== 'allowed') onBlocked({ host: hostOf(host), reason: verdict })
    return { verdict, address: addresses[0] }
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      const target = new URL(incoming.url ?? '')
      if (target.protocol !== 'http:') throw new Error('Only plain HTTP is proxied without CONNECT')
      const { verdict, address } = await decide(target.hostname)
      if (verdict !== 'allowed') {
        outgoing.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
        return outgoing.end(blockedPage(hostOf(target.hostname)))
      }
      const headers = { ...incoming.headers, host: target.host }
      delete headers['proxy-connection']
      delete headers['proxy-authorization']
      const forwarded = request(
        {
          host: address,
          port: target.port || 80,
          method: incoming.method,
          path: `${target.pathname}${target.search}`,
          headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(outgoing)
        },
      )
      forwarded.on('error', () => outgoing.destroy())
      incoming.pipe(forwarded)
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    }
  })
  server.on('connect', async (incoming, client, head) => {
    client.on('error', () => client.destroy())
    try {
      const { hostname, port } = new URL(`http://${incoming.url}`)
      const { verdict, address } = await decide(hostname)
      if (verdict !== 'allowed') return client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      const upstream = openSocket(Number(port || 443), address, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })),
  )
}
