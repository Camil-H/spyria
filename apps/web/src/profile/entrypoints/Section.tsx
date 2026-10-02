import { type ReactNode, useId } from 'react'

export const Section = ({ title, level = 2, children }: { title: string; level?: 2 | 3; children: ReactNode }) => {
  const headingId = useId()
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <Heading id={headingId} className={level === 2 ? 'text-lg font-semibold' : 'text-sm font-semibold'}>
        {title}
      </Heading>
      {children}
    </section>
  )
}
