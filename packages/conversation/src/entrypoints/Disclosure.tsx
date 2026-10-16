import { focusRing } from '@hq/ui'
import { ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { AgentStep } from '../domain/agent-steps.ts'
import { durationLabelOf } from '../queries/get-conversation.ts'

export const Disclosure = ({
  label,
  isInitiallyOpen = false,
  preview,
  children,
}: {
  label: ReactNode
  isInitiallyOpen?: boolean
  preview?: ReactNode
  children: ReactNode
}) => {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen)
  return (
    <>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex max-w-full items-center gap-1.5 rounded-md text-left text-sm text-muted hover:text-ink ${focusRing} aria-expanded:[&>svg:first-child]:rotate-90`}
      >
        <ChevronRight aria-hidden className="size-4 shrink-0 transition-transform" />
        {label}
      </button>
      {isOpen ? children : preview}
    </>
  )
}

export const ThoughtStep = ({ step }: { step: Extract<AgentStep, { type: 'thought' }> }) => (
  <Disclosure
    label={
      step.durationMilliseconds === null ? 'Thinking…' : `Thought for ${durationLabelOf(step.durationMilliseconds)}`
    }
    isInitiallyOpen={step.durationMilliseconds === null}
  >
    <p className="mt-1 border-l-2 border-line pl-3 text-sm whitespace-pre-wrap text-muted">{step.text}</p>
  </Disclosure>
)
