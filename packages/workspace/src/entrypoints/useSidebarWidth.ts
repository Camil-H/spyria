import { useState } from 'react'

export const minimumSidebarWidth = 240
export const maximumSidebarWidth = 400
export const sidebarWidthVariable = '--sidebar-width'
const defaultSidebarWidth = 256
const widthStorageKey = 'spyria.sidebar-width'

export const sidebarWidthOf = (storedWidth: string | null) => {
  const width = Number(storedWidth)
  if (storedWidth === null || !Number.isFinite(width)) return defaultSidebarWidth
  return Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, Math.round(width)))
}

const storedWidth = () => {
  try {
    return sidebarWidthOf(localStorage.getItem(widthStorageKey))
  } catch {
    return defaultSidebarWidth
  }
}

export const useSidebarWidth = () => {
  const [width, setWidth] = useState(storedWidth)
  const resizeTo = (nextWidth: number) => {
    setWidth(nextWidth)
    try {
      localStorage.setItem(widthStorageKey, String(nextWidth))
    } catch {}
  }
  return { width, resizeTo }
}
