import type { ChatRow, ProjectRow, Store } from '@hq/db'
import type { Transactor, UnitOfWork } from '../contracts/transactor.ts'
import type { Chat } from '../domain/chat.ts'
import { ChatNotFound, ProjectNotFound } from '../domain/errors.ts'
import { Name } from '../domain/name.ts'
import type { Project } from '../domain/project.ts'

const toProject = (row: ProjectRow): Project => ({ ...row, name: Name(row.name) })
const toChat = (row: ChatRow): Chat => ({ ...row, name: Name(row.name) })
const replaceById = <Row extends { id: string }>(rows: readonly Row[], replacement: Row) =>
  rows.map((row) => (row.id === replacement.id ? replacement : row))

export const createStoreTransactor = (store: Store): Transactor => ({
  run: async (work) => {
    const initial = store.read()
    let { projects, chats } = initial
    const unitOfWork: UnitOfWork = {
      projects: {
        get: async (projectId) => {
          const row = projects.find((candidate) => candidate.id === projectId)
          if (!row) throw new ProjectNotFound(projectId)
          return toProject(row)
        },
        add: async (project) => {
          projects = [...projects, project]
        },
        save: async (project) => {
          projects = replaceById(projects, project)
        },
      },
      chats: {
        get: async (chatId) => {
          const row = chats.find((candidate) => candidate.id === chatId)
          if (!row) throw new ChatNotFound(chatId)
          return toChat(row)
        },
        add: async (chat) => {
          chats = [...chats, chat]
        },
        save: async (chat) => {
          chats = replaceById(chats, chat)
        },
        listByProject: async (projectId) => chats.filter((row) => row.projectId === projectId).map(toChat),
      },
    }
    const result = await work(unitOfWork)
    if (projects !== initial.projects || chats !== initial.chats)
      store.write((current) => ({ ...current, projects, chats }))
    return result
  },
})
