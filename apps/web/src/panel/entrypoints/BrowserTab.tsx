import { useQuery } from '@hq/db'
import { getBrowser } from '../queries/get-browser.ts'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'

export const BrowserTab = ({ workspaceId, chatId }: TabProps) => {
  const page = useQuery(getBrowser(workspaceId, chatId))
  if (!page) return <p className={emptyClass}>No page open</p>
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="break-all rounded-md border border-line bg-raised px-2 py-1 font-mono text-xs">{page.url}</p>
      <h2 className="font-semibold">{page.title}</h2>
      <p>{page.bodyText}</p>
    </div>
  )
}
