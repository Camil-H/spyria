export type ModelCallFailure =
  | { reached: 'answered'; status: number; body: unknown }
  | { reached: 'unreachable' | 'timeout' | 'refused' }
type Names = { memberName: string; model: string }
type Fields = Record<string, unknown> | undefined

const authCodes = [
  'invalid_api_key',
  'authentication_error',
  'permission_error',
  'permission_denied',
  'api_key_invalid',
]
const unavailableModelCodes = ['model_blocked', 'provider_blocked', 'no_key_supports_model']
const unavailableStatuses = [500, 502, 503, 529]

export const noLlmKeyNoticeOf = (memberName: string) => `${memberName} has no LLM key in this workspace`
export const genericModelCallNoticeOf = (status: number) => `The model call failed (error ${status})`

const codesOf = (body: unknown) => {
  const fields = body as Fields
  const error = fields?.error as Fields
  const details = Array.isArray(error?.details) ? (error.details as Fields[]) : []
  return [fields?.type, error?.type, error?.code, error?.status, ...details.map((detail) => detail?.reason)]
    .filter((code): code is string => typeof code === 'string')
    .map((code) => code.toLowerCase())
}

export const modelCallNoticeOf = (failure: ModelCallFailure, { memberName, model }: Names) => {
  if (failure.reached !== 'answered')
    return {
      unreachable: 'The model gateway is unreachable',
      timeout: 'The model took too long to respond',
      refused: noLlmKeyNoticeOf(memberName),
    }[failure.reached]
  const { status } = failure
  const codes = codesOf(failure.body)
  const hasCode = (candidates: string[]) => codes.some((code) => candidates.includes(code))
  if (status === 504) return 'The model took too long to respond'
  if (status === 401 || ([400, 403].includes(status) && hasCode(authCodes)))
    return `The LLM key of ${memberName} was refused`
  if ([400, 403].includes(status) && hasCode(unavailableModelCodes))
    return `${model} isn't available with ${memberName}'s keys`
  if (status === 429 && codes.some((code) => code === 'insufficient_quota' || code.includes('billing')))
    return `The provider account of ${memberName} is out of credit`
  if (status === 429) return 'Rate limited by the provider, try again shortly'
  if (status === 400 && hasCode(['context_length_exceeded'])) return 'The conversation is too long for this model'
  if (status === 400) return 'The model rejected the request'
  if (unavailableStatuses.includes(status)) return 'The provider is unavailable, try again shortly'
  return genericModelCallNoticeOf(status)
}

export const publicModelNameOf = (model: string | undefined) => model?.split('/').at(-1) || 'this model'
