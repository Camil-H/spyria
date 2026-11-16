const openedFoldsKey = 'spyria.openedFolds'
const rememberedFolds = 200

export const withFoldOpening = (openedIds: readonly string[], foldId: string, isOpen: boolean) => {
  const others = openedIds.filter((id) => id !== foldId)
  return isOpen ? [...others, foldId].slice(-rememberedFolds) : others
}

const storedOpenedFolds = (): string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(openedFoldsKey) ?? '[]')
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

export const isFoldOpened = (foldId: string) => storedOpenedFolds().includes(foldId)

export const rememberFoldOpening = (foldId: string, isOpen: boolean) => {
  try {
    localStorage.setItem(openedFoldsKey, JSON.stringify(withFoldOpening(storedOpenedFolds(), foldId, isOpen)))
  } catch {}
}
