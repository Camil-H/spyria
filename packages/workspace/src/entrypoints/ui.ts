import { focusRing } from '@hq/ui'

export const menuTriggerClass = `flex items-center rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink data-[state=open]:bg-hover ${focusRing}`
export const fullScreenClass =
  'flex h-screen flex-col items-center justify-center gap-4 bg-app p-6 text-center text-ink'
export const navLinkClass =
  (layoutClass: string) =>
  ({ isActive }: { isActive: boolean }) =>
    `${layoutClass} rounded-md px-2 text-sm ${focusRing} ${isActive ? 'bg-selected font-medium' : 'hover:bg-hover'}`
