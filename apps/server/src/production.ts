const minimumSecretLength = 32
const requiredSettings = [
  'SPYRIA_SMTP_URL',
  'SPYRIA_MAIL_FROM',
  'SPYRIA_GATEWAY_URL',
  'SPYRIA_GATEWAY_ADMIN_USER',
  'SPYRIA_GATEWAY_ADMIN_PASSWORD',
]
const isDevelopmentDefault = (value: string) => value === 'spyria' || value.startsWith('spyria-dev-')
const originOf = (url: string) => URL.parse(url)?.origin

const secretProblemOf = (name: string, value: string) => {
  if (!value) return `${name} is required.`
  if (value.length < minimumSecretLength) return `${name} must be at least ${minimumSecretLength} characters.`
  if (isDevelopmentDefault(value)) return `${name} must not be a development default.`
}

export const productionProblemsOf = (environment: Record<string, string | undefined>) => {
  const mode = environment.SPYRIA_ENV
  if (!mode) return []
  if (mode !== 'production') return [`SPYRIA_ENV must be unset (development) or production, not ${mode}.`]
  const settingOf = (name: string) => environment[name] ?? ''
  const appOrigin = settingOf('SPYRIA_APP_ORIGIN')
  const problems = [
    settingOf('SPYRIA_AUTH_MODE') !== 'sso' && 'SPYRIA_AUTH_MODE must be sso.',
    secretProblemOf('SPYRIA_TOKEN_SECRET', settingOf('SPYRIA_TOKEN_SECRET')),
    secretProblemOf('SPYRIA_SECRETS_KEY', settingOf('SPYRIA_SECRETS_KEY')),
    !appOrigin.startsWith('https://') && 'SPYRIA_APP_ORIGIN must start with https://.',
    (!originOf(appOrigin) || originOf(settingOf('SPYRIA_OIDC_REDIRECT_URI')) !== originOf(appOrigin)) &&
      'SPYRIA_OIDC_REDIRECT_URI must be on SPYRIA_APP_ORIGIN.',
    ...requiredSettings.map((name) => !settingOf(name) && `${name} is required.`),
    ![undefined, '', 'cloudflare'].includes(environment.SPYRIA_TRUSTED_PROXY) &&
      'SPYRIA_TRUSTED_PROXY must be unset or cloudflare.',
    ...['SPYRIA_GATEWAY_ADMIN_USER', 'SPYRIA_GATEWAY_ADMIN_PASSWORD'].map(
      (name) => isDevelopmentDefault(settingOf(name)) && `${name} must not be a development default.`,
    ),
  ]
  return problems.filter((problem) => typeof problem === 'string')
}
