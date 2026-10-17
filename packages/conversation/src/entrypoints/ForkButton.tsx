import { ErrorMessage, focusRing, Spinner, useGuardedAction } from '@hq/ui'
import { GitFork } from 'lucide-react'

export const ForkButton = ({ onFork }: { onFork: () => Promise<unknown> }) => {
  const { errorMessage, isPending, run } = useGuardedAction()
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => run(onFork)}
        className={`flex w-fit items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
      >
        {isPending ? <Spinner /> : <GitFork aria-hidden size={12} />}
        {isPending ? 'Forking…' : 'Fork into my session'}
      </button>
      <ErrorMessage message={errorMessage} />
    </div>
  )
}
