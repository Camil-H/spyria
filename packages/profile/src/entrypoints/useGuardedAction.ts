import { useState } from 'react'
import { ProfileError } from '../domain/errors.ts'

export const useGuardedAction = () => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
      setErrorMessage(null)
      return true
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error
      setErrorMessage(error.message)
      return false
    }
  }
  return { errorMessage, run }
}
