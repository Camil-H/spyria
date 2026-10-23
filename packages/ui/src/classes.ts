export const focusRing = 'focus-visible:outline-2 -outline-offset-2 focus-visible:outline-focus'
export const buttonClass = `rounded-full px-4 py-1.5 text-sm font-medium bg-accent text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent ${focusRing}`
export const dangerButtonClass = `rounded-full border border-line px-4 py-1.5 text-sm font-medium bg-removed text-ink hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100 ${focusRing}`
export const ghostButtonClass = `rounded-full border border-line px-4 py-1.5 text-sm text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent ${focusRing}`
export const labelClass = 'flex flex-col gap-1 text-sm text-muted'
export const fieldClass = `rounded-md border border-line bg-app px-2 py-1.5 text-sm text-ink [&:is(select)]:pr-8 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`
export const menuItemClass =
  'flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40'
export const menuContentClass = 'z-50 min-w-40 rounded-lg border border-line bg-raised p-1 text-sm text-ink shadow-lg'
export const iconButtonClass = `rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink ${focusRing}`
export const tabTriggerClass = `border-b-2 border-transparent py-2 text-muted hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink ${focusRing}`
export const tooltipClass = 'z-50 rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink shadow-lg'
