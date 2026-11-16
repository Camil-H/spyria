export type BrowserSettings = Readonly<{
  forAgents: boolean
  forMembers: boolean
  blockInternalNetworks: boolean
  allowedInternalAddresses: readonly string[]
  allowedSites: readonly string[]
  blockedSites: readonly string[]
  signInHours: number | null
  downloads: boolean
  uploads: boolean
  approveSubmits: boolean
  recordVisits: boolean
}>

export const defaultBrowserSettings: BrowserSettings = {
  forAgents: true,
  forMembers: true,
  blockInternalNetworks: true,
  allowedInternalAddresses: [],
  allowedSites: [],
  blockedSites: [],
  signInHours: null,
  downloads: true,
  uploads: true,
  approveSubmits: true,
  recordVisits: true,
}

export const browserSignInHours = { minimum: 1, maximum: 24 * 30 } as const
export const maximumBrowserAddresses = 200
const maximumAddressLength = 253
const hostNamePattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const ipv6Pattern = /^[0-9a-f:.]+$/

export const browserAddressOf = (typed: string) => {
  const trimmed = typed
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
  const host = trimmed.startsWith('[') ? trimmed.slice(1, trimmed.indexOf(']')) : trimmed.split(/[/:]/)[0]
  return host?.replace(/\.$/, '') ?? ''
}

export const isBrowserAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= maximumAddressLength &&
  (hostNamePattern.test(value) || (value.includes(':') && ipv6Pattern.test(value)))

const isAddressList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= maximumBrowserAddresses &&
  value.every(isBrowserAddress) &&
  new Set(value).size === value.length

const isSignInHours = (value: unknown) =>
  value === null ||
  (Number.isSafeInteger(value) &&
    (value as number) >= browserSignInHours.minimum &&
    (value as number) <= browserSignInHours.maximum)

const switches = [
  'forAgents',
  'forMembers',
  'blockInternalNetworks',
  'downloads',
  'uploads',
  'approveSubmits',
  'recordVisits',
] as const

export const isBrowserSettings = (value: unknown): value is BrowserSettings => {
  const settings = (value ?? {}) as Record<string, unknown>
  return (
    switches.every((name) => typeof settings[name] === 'boolean') &&
    isAddressList(settings.allowedInternalAddresses) &&
    isAddressList(settings.allowedSites) &&
    isAddressList(settings.blockedSites) &&
    isSignInHours(settings.signInHours) &&
    Object.keys(settings).length === Object.keys(defaultBrowserSettings).length
  )
}

export const browserSettingsFrom = (stored: unknown): BrowserSettings =>
  isBrowserSettings(stored) ? stored : defaultBrowserSettings
