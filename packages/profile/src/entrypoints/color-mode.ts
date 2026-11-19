import { type ColorMode, colorModeOf } from '../domain/color-mode.ts'

const colorModeStorageKey = 'spyria.color-mode'

export const storedColorMode = () => {
  try {
    return colorModeOf(localStorage.getItem(colorModeStorageKey))
  } catch {
    return colorModeOf(null)
  }
}

export const rememberColorMode = (colorMode: ColorMode) => {
  document.documentElement.dataset.colorMode = colorMode
  try {
    localStorage.setItem(colorModeStorageKey, colorMode)
  } catch {}
}
