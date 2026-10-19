import { afterAll } from 'bun:test'
import { buildTemplateDatabase, databaseDropTimeoutMilliseconds, startTestDex } from '@spyria/db/testing'
import { stopAllSpyriaAgents } from './spyria-agent-relay.ts'
import { stopSharedTestApp } from './testing.ts'

await Promise.all([buildTemplateDatabase(), startTestDex()])
afterAll(stopSharedTestApp, databaseDropTimeoutMilliseconds)
afterAll(stopAllSpyriaAgents)
