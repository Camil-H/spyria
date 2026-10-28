import { nonBlank } from '@spyria/kernel'
import { BlankSecret } from './errors.ts'

const redaction = '[redacted]'
const maximumShownCharacters = 4

export class Secret {
  readonly #value: string

  constructor(rawValue: string) {
    nonBlank(rawValue, BlankSecret)
    this.#value = rawValue
  }

  toString() {
    return redaction
  }

  toJSON() {
    return redaction
  }

  reveal() {
    return this.#value
  }

  last4() {
    const trimmedValue = this.#value.trimEnd()
    const shownCharacters = Math.min(maximumShownCharacters, Math.floor(trimmedValue.length / 2))
    return trimmedValue.slice(trimmedValue.length - shownCharacters)
  }
}
