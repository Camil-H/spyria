import { type ReactNode, useId } from 'react'

export const LabelledSection = ({
  title,
  Heading = 'h2',
  className = 'flex flex-col gap-3',
  titleClass = 'text-lg font-semibold',
  children,
}: {
  title: string
  Heading?: 'h2' | 'h3'
  className?: string
  titleClass?: string
  children: ReactNode
}) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={className}>
      <Heading id={headingId} className={titleClass}>
        {title}
      </Heading>
      {children}
    </section>
  )
}
