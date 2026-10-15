import { afterAll } from 'bun:test'
import { buildTemplateDatabase, databaseDropTimeoutMilliseconds } from '@hq/db/testing'
import { stopAllHqAgents } from './agent-bridge/hq-agent-relay.ts'
import { stopSharedTestApp } from './testing.ts'

await buildTemplateDatabase()
afterAll(stopSharedTestApp, databaseDropTimeoutMilliseconds)
afterAll(stopAllHqAgents)
