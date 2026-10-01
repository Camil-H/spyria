declare const brand: unique symbol

export type Brand<Name extends string> = string & { readonly [brand]: Name }

export type WorkspaceId = Brand<'WorkspaceId'>
export type ProjectId = Brand<'ProjectId'>
export type ChatId = Brand<'ChatId'>
export type MemberId = Brand<'MemberId'>

export const workspaceId = (value: string) => value as WorkspaceId
export const projectId = (value: string) => value as ProjectId
export const chatId = (value: string) => value as ChatId
export const memberId = (value: string) => value as MemberId
