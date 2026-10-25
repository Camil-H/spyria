const tokenFormat = /sk-ant-(?:oat|ort)[\w-]*|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g
const minimumSecretLength = 8

export const redacted = (text: string, secrets: readonly string[]) =>
  secrets
    .filter((secret) => secret.length >= minimumSecretLength)
    .reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text)
    .replace(tokenFormat, '[redacted]')
