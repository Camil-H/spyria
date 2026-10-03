import { type ReactNode, useId } from 'react'

export const Section = ({ title, children }: { title: string; children: ReactNode }) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}
