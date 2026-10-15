import { expect, test } from 'bun:test'
import {
  isContextWindowFailure,
  type ModelCallFailure,
  modelCallNoticeOf,
  publicModelNameOf,
} from './model-call-failures.ts'

const names = { memberName: 'Alice', model: 'fake-model' }
const answered = (status: number, body: unknown): ModelCallFailure => ({ reached: 'answered', status, body })
const recordedBifrost = {
  providerKeyRefused: {
    is_bifrost_error: false,
    status_code: 401,
    error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided: go****ey' },
    extra_fields: { routing_info: { provider: 'fake', model: 'fake-model', key: 'cred_bad' }, provider: 'fake' },
  },
  virtualKeyRevoked: {
    type: 'access_not_found',
    is_bifrost_error: false,
    status_code: 401,
    error: { message: 'access not found. The provided credential does not exist or has been revoked.' },
  },
  modelBlocked: {
    type: 'model_blocked',
    status_code: 403,
    error: { message: "Model 'fake-model' is not allowed for virtual key 'vk_0f3a'" },
  },
  providerBlocked: {
    type: 'provider_blocked',
    status_code: 403,
    error: { message: "Provider 'openai' is not allowed for virtual key 'vk_a'" },
    extra_fields: { error_type: 'policy_provider_blocked' },
  },
  noKeyForModel: {
    type: 'no_key_supports_model',
    status_code: 400,
    error: {
      error: 'no keys found for provider: fake and model: fake-model',
      type: 'no_key_supports_model',
      message: 'no keys found for provider: fake and model: fake-model',
    },
  },
  rateLimited: {
    type: 'request_limited',
    status_code: 429,
    error: { message: 'Rate limit exceeded: request limit exceeded (1/1, resets every 1h)' },
  },
}
const openAi = {
  invalidKey: {
    error: {
      message: 'Incorrect API key provided: sk-t****7890.',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_api_key',
    },
  },
  insufficientQuota: {
    error: {
      message: 'You exceeded your current quota.',
      type: 'insufficient_quota',
      param: null,
      code: 'insufficient_quota',
    },
  },
  rateLimited: {
    error: { message: 'Rate limit reached for gpt-4o.', type: 'requests', param: null, code: 'rate_limit_exceeded' },
  },
  contextTooLong: {
    error: {
      message: "This model's maximum context length is 128000 tokens.",
      type: 'invalid_request_error',
      param: 'messages',
      code: 'context_length_exceeded',
    },
  },
  badRequest: { error: { message: "Invalid value for 'temperature'.", type: 'invalid_request_error', code: null } },
  serverError: { error: { message: 'The server had an error.', type: 'server_error', code: null } },
}
const anthropic = {
  invalidKey: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
  forbidden: { type: 'error', error: { type: 'permission_error', message: 'Your API key does not have permission.' } },
  rateLimited: {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' },
  },
  overloaded: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
}
const gemini = {
  invalidKey: {
    error: {
      code: 400,
      message: 'API key not valid. Please pass a valid API key.',
      status: 'INVALID_ARGUMENT',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
      ],
    },
  },
  forbidden: { error: { code: 403, message: 'Permission denied.', status: 'PERMISSION_DENIED' } },
  exhausted: { error: { code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED' } },
  unavailable: { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } },
}

const keyRefused = 'The LLM key of Alice was refused'
const modelUnavailable = "fake-model isn't available with Alice's keys"
const outOfCredit = 'The provider account of Alice is out of credit'
const rateLimited = 'Rate limited by the provider, try again shortly'
const tooLong = 'The conversation is too long for this model'
const rejected = 'The model rejected the request'
const unavailable = 'The provider is unavailable, try again shortly'

test.each([
  ['the gateway unreachable', { reached: 'unreachable' }, 'The model gateway is unreachable'],
  ['no answer in time', { reached: 'timeout' }, 'The model took too long to respond'],
  ['a gateway timeout status', answered(504, ''), 'The model took too long to respond'],
  ['a call refused by HQ', { reached: 'refused' }, 'Alice has no LLM key in this workspace'],
  ['Bifrost: provider key refused', answered(401, recordedBifrost.providerKeyRefused), keyRefused],
  ['Bifrost: virtual key revoked', answered(401, recordedBifrost.virtualKeyRevoked), keyRefused],
  ['Bifrost: model blocked', answered(403, recordedBifrost.modelBlocked), modelUnavailable],
  ['Bifrost: provider blocked', answered(403, recordedBifrost.providerBlocked), modelUnavailable],
  ['Bifrost: no key for the model', answered(400, recordedBifrost.noKeyForModel), modelUnavailable],
  ['Bifrost: rate limit', answered(429, recordedBifrost.rateLimited), rateLimited],
  ['OpenAI: invalid key', answered(401, openAi.invalidKey), keyRefused],
  ['OpenAI: insufficient quota', answered(429, openAi.insufficientQuota), outOfCredit],
  ['OpenAI: rate limit', answered(429, openAi.rateLimited), rateLimited],
  ['OpenAI: context length', answered(400, openAi.contextTooLong), tooLong],
  ['OpenAI: other bad request', answered(400, openAi.badRequest), rejected],
  ['OpenAI: server error', answered(500, openAi.serverError), unavailable],
  ['OpenAI: bad gateway', answered(502, 'upstream connect error'), unavailable],
  ['Anthropic: invalid key', answered(401, anthropic.invalidKey), keyRefused],
  ['Anthropic: permission', answered(403, anthropic.forbidden), keyRefused],
  ['Anthropic: rate limit', answered(429, anthropic.rateLimited), rateLimited],
  ['Anthropic: overloaded', answered(529, anthropic.overloaded), unavailable],
  ['Gemini: invalid key', answered(400, gemini.invalidKey), keyRefused],
  ['Gemini: permission denied', answered(403, gemini.forbidden), keyRefused],
  ['Gemini: exhausted', answered(429, gemini.exhausted), rateLimited],
  ['Gemini: unavailable', answered(503, gemini.unavailable), unavailable],
  [
    'an unknown 404',
    answered(404, { error: { message: 'Not found: secret details' } }),
    'The model call failed (error 404)',
  ],
  [
    'a 403 without an auth code',
    answered(403, { error: { message: 'Forbidden' } }),
    'The model call failed (error 403)',
  ],
  ['a body that is not JSON', answered(418, "I'm a teapot"), 'The model call failed (error 418)'],
] as [string, ModelCallFailure, string][])('%s', (_, failure, notice) => {
  expect(modelCallNoticeOf(failure, names)).toBe(notice)
})

test('a notice never carries the provider or gateway text', () => {
  const bodies = [
    ...Object.values(recordedBifrost),
    ...Object.values(openAi),
    ...Object.values(anthropic),
    ...Object.values(gemini),
  ]
  for (const body of bodies)
    for (const status of [400, 401, 403, 404, 429, 500])
      expect(modelCallNoticeOf(answered(status, body), names)).toMatch(/^(The|Rate|Alice|fake-model)[^:*]*$/)
})

test('the public model name drops the provider route', () => {
  expect(publicModelNameOf('fake/fake-model')).toBe('fake-model')
  expect(publicModelNameOf('openai/anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  expect(publicModelNameOf('gpt-4o')).toBe('gpt-4o')
  expect(publicModelNameOf(undefined)).toBe('this model')
})

test('a context-window rejection is recognized so the agent can compact without a failure notice', () => {
  expect(isContextWindowFailure(answered(400, openAi.contextTooLong))).toBe(true)
  expect(
    isContextWindowFailure(
      answered(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' },
      }),
    ),
  ).toBe(true)
  expect(isContextWindowFailure(answered(400, openAi.badRequest))).toBe(false)
  expect(isContextWindowFailure(answered(429, openAi.rateLimited))).toBe(false)
})
