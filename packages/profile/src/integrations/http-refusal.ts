import { domainErrorOf } from '@spyria/kernel'

export const throwOnRefusal = async (response: Response, request: string) => {
  if (response.status === 400) {
    const { error, message } = (await response.json()) as { error: string; message: string }
    throw domainErrorOf(error, message)
  }
  if (!response.ok) throw new Error(`${request} was refused with ${response.status}`)
}
