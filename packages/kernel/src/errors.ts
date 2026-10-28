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

const kindByCode = new Map<string, new (...details: never) => DomainError>()

export const errorKind = <Details extends unknown[]>(
  code: string,
  messageOf: (...details: Details) => string,
  Base: typeof DomainError,
) => {
  const Kind = class extends Base {
    constructor(...details: Details) {
      super(code, messageOf(...details))
    }
  }
  kindByCode.set(code, Kind)
  return Kind
}

export const domainErrorOf = (code: string, message: string): DomainError =>
  Reflect.construct(DomainError, [code, message], kindByCode.get(code) ?? DomainError)

export const refusalOf = (status: number, { error, message }: { error?: string; message?: string }) =>
  domainErrorOf(error ?? 'internal', message ?? `The request was refused with ${status}`)

export const ForeignWorkspace = errorKind(
  'foreign_workspace',
  () => 'The change targets a workspace other than the current one',
  DomainError,
)
export const ChatNotFound = errorKind('chat_not_found', (chatId: string) => `Chat ${chatId} was not found`, DomainError)
export const MemberNotFound = errorKind(
  'member_not_found',
  (memberId: string) => `${memberId} is not a member of this workspace`,
  DomainError,
)

export const blankKind = (code: string, subject: string, Base: typeof DomainError) =>
  errorKind(code, () => `${subject} must contain at least one non-blank character`, Base)

export const nonBlank = (rawValue: string, Blank: new () => DomainError) => {
  const trimmedValue = rawValue.trim()
  if (trimmedValue === '') throw new Blank()
  return trimmedValue
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
