const pickedColorMode = () => {
  try {
    return localStorage.getItem('spyria.color-mode')
  } catch {
    return null
  }
}
const storedColorMode = pickedColorMode()
document.documentElement.dataset.colorMode =
  storedColorMode === 'light' || storedColorMode === 'dark' ? storedColorMode : 'system'
