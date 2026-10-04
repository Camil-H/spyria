export class ConversationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class BlankMessageBody extends ConversationError {
  constructor() {
    super('blank_message_body', 'A message must contain at least one non-blank character')
  }
}

export class NotMessageAuthor extends ConversationError {
  constructor() {
    super('not_message_author', 'Only the author can change a message')
  }
}

export class MessageDeleted extends ConversationError {
  constructor() {
    super('message_deleted', 'A deleted message cannot be changed')
  }
}

export class MessageNotFound extends ConversationError {
  constructor(messageId: string) {
    super('message_not_found', `Message ${messageId} was not found`)
  }
}

export class ChatNotFound extends ConversationError {
  constructor(chatId: string) {
    super('chat_not_found', `Chat ${chatId} was not found`)
  }
}

export class ForeignWorkspace extends ConversationError {
  constructor() {
    super('foreign_workspace', 'The change targets a workspace other than the current one')
  }
}
