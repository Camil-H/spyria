import { focusRing, iconButtonClass, useShortcut } from '@spyria/ui'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'

export type PageCard = { path: string; title: string; description: string; isWide?: true }

export const pagePaddingClass = 'px-6 py-6 md:px-12 xl:px-16'

export const CardGrid = ({
  basePath,
  cards,
  statusOf,
  badgeOf,
}: {
  basePath: string
  cards: readonly PageCard[]
  statusOf: (path: string) => string | undefined
  badgeOf?: (path: string) => ReactNode
}) => (
  <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
    {cards.map(({ path, title, description }) => {
      const status = statusOf(path)
      return (
        <li key={path}>
          <Link
            to={`${basePath}/${path}`}
            aria-label={title}
            aria-describedby={`card-${path}`}
            className={`flex h-full flex-col gap-1 rounded-lg border border-line bg-raised p-4 hover:bg-hover ${focusRing}`}
          >
            <span className="flex items-center justify-between gap-2 font-medium">
              {title}
              {badgeOf?.(path)}
            </span>
            <span id={`card-${path}`} className="flex flex-1 flex-col gap-2 text-sm text-muted">
              {description}
              {status && <span className="mt-auto text-xs text-ink">{status}</span>}
            </span>
          </Link>
        </li>
      )
    })}
  </ul>
)

export const CardPage = ({
  backPath,
  backLabel,
  card,
  children,
}: {
  backPath: string
  backLabel: string
  card: PageCard
  children: ReactNode
}) => {
  const navigate = useNavigate()
  useShortcut('escape', backLabel, () => navigate(backPath))
  return (
    <div className={`flex flex-col gap-6 ${pagePaddingClass} ${card.isWide ? '' : 'max-w-4xl'}`}>
      <div className="flex items-center gap-2">
        <Link to={backPath} aria-label={backLabel} className={iconButtonClass}>
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <h1 className="text-2xl font-semibold">{card.title}</h1>
      </div>
      {children}
    </div>
  )
}
