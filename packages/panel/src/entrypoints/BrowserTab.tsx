import { useQuery, useScoped } from '@spyria/db/react'
import { Globe } from 'lucide-react'
import { getBrowser } from '../queries/get-browser.ts'
import { EmptyState } from './EmptyState.tsx'
import type { TabProps } from './TabProps.ts'

export const BrowserTab = ({ workspaceId, chatId }: TabProps) => {
  const isComplete = useScoped(workspaceId, 'chatBrowserPages', { chatId })?.isComplete === true
  const page = useQuery(getBrowser, workspaceId, chatId)
  if (!page && !isComplete) return null
  if (!page) return <EmptyState Icon={Globe} title="No page open" hint="Pages the agent browses show here." />
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="break-all rounded-md border border-line bg-raised px-2 py-1 font-mono text-xs">{page.url}</p>
      <h2 className="font-semibold">{page.title}</h2>
    </div>
  )
}
