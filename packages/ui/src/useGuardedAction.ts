import { DomainError } from '@spyria/kernel'
import { useState } from 'react'

export const unexpectedFailureMessage = 'Something went wrong. Try again.'

export const failureMessageOf = (error: unknown) =>
  error instanceof DomainError ? error.message : unexpectedFailureMessage

export const failureOfAttempt = async (action: () => Promise<unknown>) => {
  try {
    await action()
    return null
  } catch (error) {
    if (!(error instanceof DomainError)) console.error(error)
    return failureMessageOf(error)
  }
}

export const useGuardedAction = () => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setIsPending(true)
    const failure = await failureOfAttempt(action)
    setErrorMessage(failure)
    setIsPending(false)
    return failure === null
  }
  return { errorMessage, isPending, run }
}
