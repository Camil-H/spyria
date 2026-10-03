import { BlankSecret } from './errors.ts'

const redaction = '[redacted]'
const lastCharacterCount = 4

export class Secret {
  readonly #value: string

  constructor(rawValue: string) {
    if (rawValue.trim() === '') throw new BlankSecret()
    this.#value = rawValue
  }

  toString() {
    return redaction
  }

  toJSON() {
    return redaction
  }

  last4() {
    return this.#value.trimEnd().slice(-lastCharacterCount)
  }
}
