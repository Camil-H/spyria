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

const codeOf = (error: Error) => {
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

export const errorSummaryOf = (error: unknown) => {
  if (error instanceof DomainError) return error.message
  if (!(error instanceof Error)) return 'unknown error'
  const code = codeOf(error)
  return code ? `${error.name} ${code}` : error.name
}

export const carriesQueryParameters = (error: unknown) => error instanceof Error && 'params' in error

export const disclosableMessageOf = (error: unknown) =>
  error instanceof Error && !carriesQueryParameters(error) ? error.message : errorSummaryOf(error)
