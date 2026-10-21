import { afterAll } from 'bun:test'
import {
  buildTemplateDatabase,
  databaseDropTimeoutMilliseconds,
  startTestDex,
  startTestPostgres,
} from '@spyria/db/testing'
import { stopAllSpyriaAgents } from './spyria-agent-relay.ts'
import { stopSharedTestApp } from './testing.ts'

await Promise.all([startTestPostgres().then(() => buildTemplateDatabase()), startTestDex()])
afterAll(stopSharedTestApp, databaseDropTimeoutMilliseconds)
afterAll(stopAllSpyriaAgents)
