export class DomainError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }

  get details() {
    return { code: this.code }
  }
}

export const errorKind = <Details extends unknown[]>(
  code: string,
  messageOf: (...details: Details) => string,
  Base: typeof DomainError,
) =>
  class extends Base {
    constructor(...details: Details) {
      super(code, messageOf(...details))
    }
  }
