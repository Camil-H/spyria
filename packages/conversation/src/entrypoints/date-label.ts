const yearOf = (at: Date, timeZone: string | undefined) =>
  new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone }).format(at)

export const dateLabelOf = (at: Date, now: Date, timeZone?: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(yearOf(at, timeZone) !== yearOf(now, timeZone) && { year: 'numeric' }),
    timeZone,
  }).format(at)
