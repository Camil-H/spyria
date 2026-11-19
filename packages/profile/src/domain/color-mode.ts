export const colorModes = ['light', 'dark', 'system'] as const

export type ColorMode = (typeof colorModes)[number]

export const colorModeOf = (storedValue: string | null): ColorMode =>
  colorModes.find((colorMode) => colorMode === storedValue) ?? 'system'
