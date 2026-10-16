import { type ReactNode, useId } from 'react'

export const LabelledSection = ({
  title,
  id,
  Heading = 'h2',
  className = 'flex flex-col gap-3',
  titleClass = 'text-lg font-semibold',
  children,
}: {
  title: string
  id?: string
  Heading?: 'h2' | 'h3'
  className?: string
  titleClass?: string
  children: ReactNode
}) => {
  const headingId = useId()
  return (
    <section id={id} aria-labelledby={headingId} className={className}>
      <Heading id={headingId} className={titleClass}>
        {title}
      </Heading>
      {children}
    </section>
  )
}
