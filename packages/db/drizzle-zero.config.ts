import { drizzleZeroConfig } from 'drizzle-zero'
import * as tables from './src/postgres/tables.ts'

export default drizzleZeroConfig(tables, {
  tables: {
    users: true,
    workspaces: true,
    memberships: true,
    serviceIdentities: true,
    projects: true,
    chats: true,
    chatParticipants: true,
    messages: true,
    readMarkers: true,
    llmCredentials: { workspaceId: true, id: true, userId: true, provider: true, last4: true },
    workspaceConnections: true,
    toolConnections: true,
    files: true,
    changes: true,
    terminalLines: true,
    planSteps: true,
    commits: true,
    browserPages: true,
    sources: true,
    usageEntries: true,
  },
})
