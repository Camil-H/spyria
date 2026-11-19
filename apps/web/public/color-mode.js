try {
  document.documentElement.dataset.colorMode = localStorage.getItem('spyria.color-mode') ?? 'system'
} catch {}
