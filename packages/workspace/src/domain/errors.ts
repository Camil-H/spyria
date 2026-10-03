export class WorkspaceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class BlankName extends WorkspaceError {
  constructor() {
    super('blank_name', 'A name must contain at least one non-blank character')
  }
}

export class ProjectNotFound extends WorkspaceError {
  constructor(projectId: string) {
    super('project_not_found', `Project ${projectId} was not found`)
  }
}

export class ChatNotFound extends WorkspaceError {
  constructor(chatId: string) {
    super('chat_not_found', `Chat ${chatId} was not found`)
  }
}

export class CrossWorkspaceMove extends WorkspaceError {
  constructor() {
    super('cross_workspace_move', 'A chat can only move to a project of its own workspace')
  }
}

export class SourceChatArchived extends WorkspaceError {
  constructor() {
    super('source_chat_archived', 'A runtime chat cannot start from an archived chat')
  }
}
