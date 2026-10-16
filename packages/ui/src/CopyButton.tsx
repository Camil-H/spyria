import { useEffect, useState } from 'react'

const feedbackMilliseconds = 2000

export const CopyButton = ({ text, className, label }: { text: string; className: string; label?: string }) => {
  const [feedback, setFeedback] = useState<string | null>(null)
  useEffect(() => {
    if (feedback === null) return
    const timer = setTimeout(() => setFeedback(null), feedbackMilliseconds)
    return () => clearTimeout(timer)
  }, [feedback])
  return (
    <button
      type="button"
      aria-label={label}
      className={className}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setFeedback('✓ Copied'),
          () => setFeedback('Copy failed'),
        )
      }
    >
      {feedback ?? 'Copy'}
    </button>
  )
}
