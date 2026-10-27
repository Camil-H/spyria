import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import {
  Content as TooltipContent,
  Portal as TooltipPortal,
  Provider as TooltipProvider,
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
} from '@radix-ui/react-tooltip'
import { useQuery } from '@spyria/db/react'
import { tooltipClass, useShortcut } from '@spyria/ui'
import {
  BookOpen,
  ChartColumn,
  FileDiff,
  FolderTree,
  GitCommitHorizontal,
  Globe,
  type LucideIcon,
  Plug,
  Users,
} from 'lucide-react'
import { Activity, type ComponentType, lazy, type ReactNode, Suspense, useState } from 'react'
import { getPanelTabs, type PanelTabId } from '../queries/get-panel-tabs.ts'
import { BrowserTab } from './BrowserTab.tsx'
import { FilesTab } from './FilesTab.tsx'
import { panelToggleLabelOf, usePanel } from './providers.tsx'
import { ResizeHandle } from './ResizeHandle.tsx'
import type { PanelProps, TabProps } from './TabProps.ts'
import { tabClass } from './ui.ts'

const ChangesTab = lazy(() => import('./ChangesTab.tsx'))
const CommitsTab = lazy(() => import('./CommitsTab.tsx'))
const SourcesTab = lazy(() => import('./SourcesTab.tsx'))
const ConnectionsTab = lazy(() => import('./ConnectionsTab.tsx'))
const MembersTab = lazy(() => import('./MembersTab.tsx'))

const tabs: Record<PanelTabId, { label: string; Icon: LucideIcon; Component: ComponentType<TabProps> | null }> = {
  files: { label: 'Files', Icon: FolderTree, Component: FilesTab },
  changes: { label: 'Changes', Icon: FileDiff, Component: ChangesTab },
  commits: { label: 'Commits', Icon: GitCommitHorizontal, Component: CommitsTab },
  browser: { label: 'Browser', Icon: Globe, Component: BrowserTab },
  sources: { label: 'Sources', Icon: BookOpen, Component: SourcesTab },
  usage: { label: 'Usage', Icon: ChartColumn, Component: null },
  connections: { label: 'Connected tools', Icon: Plug, Component: ConnectionsTab },
  members: { label: 'Members', Icon: Users, Component: MembersTab },
}

const tabShortcutOf = (index: number) => `r ${index + 1}`

const TabTrigger = ({ tabId, index }: { tabId: PanelTabId; index: number }) => {
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
          {label}{' '}
          <kbd aria-hidden className="font-sans text-muted">
            R then {index + 1}
          </kbd>
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

const TabShortcut = ({ tabId, index, onSelect }: { tabId: PanelTabId; index: number; onSelect: () => void }) => {
  useShortcut(tabShortcutOf(index), `Right sidebar: ${tabs[tabId].label}`, onSelect)
  return null
}

export const SidePanel = ({ usageTab, ...panelProps }: PanelProps & { usageTab: ReactNode }) => {
  const { workspaceId, chatId } = panelProps
  const tabIds = useQuery(getPanelTabs, workspaceId, chatId)
  const { isOpen, width, fitWithin, toggle, open } = usePanel()
  const [selected, setSelected] = useState<{ chatId: string; tabId: string }>()
  if (selected && selected.chatId !== chatId) setSelected(undefined)
  const selectedTabId =
    selected?.chatId === chatId && tabIds?.some((tabId) => tabId === selected.tabId) ? selected.tabId : tabIds?.[0]
  const selectTab = (tabId: string) => setSelected({ chatId, tabId })
  useShortcut('r', panelToggleLabelOf(isOpen), toggle)
  const fitWithinRow = (section: HTMLElement | null) => {
    const row = section?.parentElement
    if (!row) return
    const observer = new ResizeObserver(([entry]) => entry && fitWithin(entry.contentRect.width))
    observer.observe(row)
    return () => observer.disconnect()
  }
  if (!tabIds || !selectedTabId) return null
  return (
    <>
      {tabIds.map((tabId, index) => (
        <TabShortcut
          key={tabId}
          tabId={tabId}
          index={index}
          onSelect={() => {
            selectTab(tabId)
            open()
          }}
        />
      ))}
      <Activity mode={isOpen ? 'visible' : 'hidden'}>
        <section
          ref={fitWithinRow}
          aria-label="Side panel"
          style={{ width }}
          className="relative flex min-w-0 shrink-0 flex-col border-l border-line bg-raised text-ink"
        >
          <ResizeHandle />
          <Root key={chatId} value={selectedTabId} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col">
            <TooltipProvider>
              <List
                aria-label="Panel tabs"
                className="flex gap-0.5 overflow-x-auto border-b border-line px-1 pt-1 scrollbar-thin"
              >
                {tabIds.map((tabId, index) => (
                  <TabTrigger key={tabId} tabId={tabId} index={index} />
                ))}
              </List>
            </TooltipProvider>
            {tabIds.map((tabId) => (
              <TabPanel key={tabId} tabId={tabId} usageTab={usageTab} {...panelProps} />
            ))}
          </Root>
        </section>
      </Activity>
    </>
  )
}
