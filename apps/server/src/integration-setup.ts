import { afterAll } from 'bun:test'
import { buildTemplateDatabase } from '@hq/db/testing'
import { stopSharedTestApp } from './testing.ts'

await buildTemplateDatabase()
afterAll(stopSharedTestApp)
