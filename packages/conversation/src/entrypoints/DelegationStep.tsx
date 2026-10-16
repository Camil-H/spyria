import { LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { type ConversationMessage, durationLabelOf } from '../queries/get-conversation.ts'
import { Disclosure, ThoughtStep } from './Disclosure.tsx'

const DelegationStep = ({
  delegation,
  children,
}: {
  delegation: NonNullable<ConversationMessage['delegation']>
  children: ReactNode
}) => {
  const { modelName, status, result, fallback, live } = delegation
  const count = delegation.steps.length
  const duration = delegation.durationMilliseconds
  return (
    <>
      <Disclosure
        label={
          status === 'running' ? (
            <>
              <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
              {`Subagent · ${modelName ? `${modelName} · ` : ''}working…`}
            </>
          ) : (
            `${modelName ? `Delegated to ${modelName}` : 'Subagent'}${status === 'finished' ? '' : ` · ${status}`} · ${count} step${count === 1 ? '' : 's'}${duration === null ? '' : ` · ${durationLabelOf(duration)}`}`
          )
        }
      >
        <fieldset
          aria-label={`Steps of ${modelName || 'the subagent'}`}
          className="mt-1 flex flex-col gap-1 rounded-r-md border-l-2 border-accent bg-raised py-1 pr-2 pl-3"
        >
          {children}
          {live &&
            (live.isReasoning ? (
              <ThoughtStep step={{ type: 'thought', text: live.text, durationMilliseconds: null }} />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{live.text}</p>
            ))}
        </fieldset>
        {result !== null && <p className="mt-1 pl-3 text-sm whitespace-pre-wrap">{result}</p>}
      </Disclosure>
      {fallback && <p className="pl-5.5 text-xs text-muted">{fallback}</p>}
    </>
  )
}

export default DelegationStep
