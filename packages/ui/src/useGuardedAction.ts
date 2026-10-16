import { DomainError } from '@hq/kernel'
import { useState } from 'react'

export const useGuardedAction = () => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
      setErrorMessage(null)
      return true
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      setErrorMessage(error.message)
      return false
    }
  }
  return { errorMessage, run }
}
