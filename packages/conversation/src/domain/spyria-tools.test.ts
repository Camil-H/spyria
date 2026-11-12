import { expect, test } from 'bun:test'
import { builtInTools } from '@spyria/kernel'
import { routerTools } from './delegation.ts'
import { devLoopTools } from './dev-loop.ts'
import { spyriaTools } from './spyria-tools.ts'
import { webSearchTool } from './web-search.ts'

test("the Built in row lists every tool of Spyria's own servers, and only those", () => {
  const served = [...spyriaTools, webSearchTool, ...routerTools, ...devLoopTools].map(({ name }) => name)
  expect(builtInTools.map(({ name }) => name).toSorted()).toEqual(served.toSorted())
})
