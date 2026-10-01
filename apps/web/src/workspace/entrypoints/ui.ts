export const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus'
export const buttonClass = `rounded-full px-4 py-1.5 text-sm font-medium bg-accent text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent ${focusRing}`
export const ghostButtonClass = `rounded-full border border-line px-4 py-1.5 text-sm text-ink hover:bg-hover ${focusRing}`
export const fieldClass = `rounded-md border border-line bg-app px-2 py-1.5 text-sm text-ink ${focusRing}`
export const menuContentClass = 'z-50 min-w-40 rounded-lg border border-line bg-raised p-1 text-sm text-ink shadow-lg'
export const menuItemClass =
  'flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover'
export const menuTriggerClass = `rounded-md px-2 text-muted hover:bg-hover hover:text-ink data-[state=open]:bg-hover ${focusRing}`
