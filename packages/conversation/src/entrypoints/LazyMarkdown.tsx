import { lazy } from 'react'

export const LazyMarkdown = lazy(() => import('./Markdown.tsx'))
export const LazyStreamedMarkdown = lazy(() =>
  import('./Markdown.tsx').then(({ StreamedMarkdown }) => ({ default: StreamedMarkdown })),
)
