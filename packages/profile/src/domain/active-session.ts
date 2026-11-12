export type ActiveSession = Readonly<{ userAgent: string; signedInAt: number; isCurrent: boolean }>

const browserMarkers = [
  ['Edg', 'Edge'],
  ['OPR/', 'Opera'],
  ['Firefox/', 'Firefox'],
  ['FxiOS/', 'Firefox'],
  ['CriOS/', 'Chrome'],
  ['Chrome/', 'Chrome'],
  ['Safari/', 'Safari'],
] as const
const systemMarkers = [
  ['iPhone', 'iPhone'],
  ['iPad', 'iPad'],
  ['Android', 'Android'],
  ['CrOS', 'ChromeOS'],
  ['Windows', 'Windows'],
  ['Mac OS X', 'macOS'],
  ['Linux', 'Linux'],
] as const

const firstMatchOf = (userAgent: string, markers: readonly (readonly [string, string])[]) =>
  markers.find(([marker]) => userAgent.includes(marker))?.[1]

export const deviceNameOf = (userAgent: string) => {
  const browser = firstMatchOf(userAgent, browserMarkers)
  const system = firstMatchOf(userAgent, systemMarkers)
  if (browser && system) return `${browser} on ${system}`
  return browser ?? system ?? 'Unknown device'
}
