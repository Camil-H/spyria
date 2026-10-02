import { focusRing } from '@hq/ui'

export const menuItemClass =
  'flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover'
export const menuTriggerClass = `flex items-center rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink data-[state=open]:bg-hover ${focusRing}`
