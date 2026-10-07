import { afterAll } from 'bun:test'
import { buildTemplateDatabase, databaseDropTimeoutMilliseconds } from '@hq/db/testing'
import { stopSharedTestApp } from './testing.ts'

await buildTemplateDatabase()
afterAll(stopSharedTestApp, databaseDropTimeoutMilliseconds)
