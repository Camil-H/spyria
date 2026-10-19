import { DomainError } from '@spyria/kernel'
import { useState } from 'react'

export const useGuardedAction = () => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setIsPending(true)
    try {
      await action()
      setErrorMessage(null)
      return true
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      setErrorMessage(error.message)
      return false
    } finally {
      setIsPending(false)
    }
  }
  return { errorMessage, isPending, run }
}
