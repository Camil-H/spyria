const scrollIntoView = (element: HTMLElement | null) => element?.scrollIntoView({ block: 'end' })

export const WorkingIndicator = () => (
  <div
    ref={scrollIntoView}
    role="status"
    aria-label="Agent is working"
    className="flex items-center gap-2 px-3 py-2 text-sm text-muted"
  >
    <span aria-hidden className="size-2 animate-pulse rounded-full bg-accent" />
    Agent is working…
  </div>
)
