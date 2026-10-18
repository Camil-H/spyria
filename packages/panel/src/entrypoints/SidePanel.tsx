import { useQuery } from '@hq/db/react'
import { tooltipClass } from '@hq/ui'
import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import {
  Content as TooltipContent,
  Portal as TooltipPortal,
  Provider as TooltipProvider,
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
} from '@radix-ui/react-tooltip'
import {
  BookOpen,
  ChartColumn,
  FileDiff,
  FolderTree,
  GitCommitHorizontal,
  Globe,
  ListChecks,
  type LucideIcon,
  Plug,
  Users,
} from 'lucide-react'
import { Activity, type ComponentType, lazy, type ReactNode, Suspense, useState } from 'react'
import { getPanelTabs, type PanelTabId } from '../queries/get-panel-tabs.ts'
import { BrowserTab } from './BrowserTab.tsx'
import { FilesTab } from './FilesTab.tsx'
import { usePanel } from './providers.tsx'
import { ResizeHandle } from './ResizeHandle.tsx'
import type { PanelProps, TabProps } from './TabProps.ts'
import { tabClass } from './ui.ts'

const ChangesTab = lazy(() => import('./ChangesTab.tsx'))
const PlanTab = lazy(() => import('./PlanTab.tsx'))
const CommitsTab = lazy(() => import('./CommitsTab.tsx'))
const SourcesTab = lazy(() => import('./SourcesTab.tsx'))
const ConnectionsTab = lazy(() => import('./ConnectionsTab.tsx'))
const MembersTab = lazy(() => import('./MembersTab.tsx'))

const tabs: Record<PanelTabId, { label: string; Icon: LucideIcon; Component: ComponentType<TabProps> | null }> = {
  files: { label: 'Files', Icon: FolderTree, Component: FilesTab },
  changes: { label: 'Changes', Icon: FileDiff, Component: ChangesTab },
  plan: { label: 'Plan', Icon: ListChecks, Component: PlanTab },
  commits: { label: 'Commits', Icon: GitCommitHorizontal, Component: CommitsTab },
  browser: { label: 'Browser', Icon: Globe, Component: BrowserTab },
  sources: { label: 'Sources', Icon: BookOpen, Component: SourcesTab },
  usage: { label: 'Usage', Icon: ChartColumn, Component: null },
  connections: { label: 'Connected tools', Icon: Plug, Component: ConnectionsTab },
  members: { label: 'Members', Icon: Users, Component: MembersTab },
}

const TabTrigger = ({ tabId }: { tabId: PanelTabId }) => {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false)
  const { label, Icon } = tabs[tabId]
  return (
    <TooltipRoot
      open={isTooltipOpen}
      onOpenChange={(isOpen) => setTimeout(() => setIsTooltipOpen(isOpen), 100)}
      disableHoverableContent
    >
      <Trigger
        asChild
        value={tabId}
        onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
      >
        <TooltipTrigger aria-label={label} className={tabClass}>
          <Icon aria-hidden className="size-4" />
        </TooltipTrigger>
      </Trigger>
      <TooltipPortal>
        <TooltipContent sideOffset={6} className={tooltipClass}>
          {label}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  )
}

const TabPanel = ({ tabId, usageTab, ...panelProps }: PanelProps & { tabId: PanelTabId; usageTab: ReactNode }) => {
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
  const { label, Component } = tabs[tabId]
  return (
    <Content value={tabId} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line px-4 py-1.5">
        <h2 className="mr-auto text-sm font-semibold">{label}</h2>
        <div
          ref={setActionsSlot}
          className="flex flex-wrap items-center justify-end gap-2 [&>button]:whitespace-nowrap"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-ink">
        <Suspense>{Component ? <Component {...panelProps} actionsSlot={actionsSlot} /> : usageTab}</Suspense>
      </div>
    </Content>
  )
}

export const SidePanel = ({ usageTab, ...panelProps }: PanelProps & { usageTab: ReactNode }) => {
  const { workspaceId, chatId } = panelProps
  const tabIds = useQuery(getPanelTabs(workspaceId, chatId))
  const { isOpen, width } = usePanel()
  if (!tabIds) return null
  return (
    <Activity mode={isOpen ? 'visible' : 'hidden'}>
      <section
        aria-label="Side panel"
        style={{ width }}
        className="relative flex min-w-0 shrink-0 flex-col border-l border-line bg-raised text-ink"
      >
        <ResizeHandle />
        <Root key={chatId} defaultValue={tabIds[0]} className="flex min-h-0 flex-1 flex-col">
          <TooltipProvider>
            <List
              aria-label="Panel tabs"
              className="flex gap-0.5 overflow-x-auto border-b border-line px-1 pt-1 scrollbar-thin"
            >
              {tabIds.map((tabId) => (
                <TabTrigger key={tabId} tabId={tabId} />
              ))}
            </List>
          </TooltipProvider>
          {tabIds.map((tabId) => (
            <TabPanel key={tabId} tabId={tabId} usageTab={usageTab} {...panelProps} />
          ))}
        </Root>
      </section>
    </Activity>
  )
}
