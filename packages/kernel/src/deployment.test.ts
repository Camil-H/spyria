import { expect, test } from 'bun:test'
import { defaultDeployment, deploymentOf, hostContainerOf } from './deployment.ts'

test('the deployment name defaults to spyria, whose host container keeps the name spyria-host', () => {
  expect(deploymentOf(undefined)).toBe('spyria')
  expect(deploymentOf('')).toBe(defaultDeployment)
  expect(hostContainerOf(defaultDeployment)).toBe('spyria-host')
  expect(hostContainerOf(deploymentOf('spyria-prod'))).toBe('spyria-prod-host')
})

test('the deployment name takes only lowercase letters, digits and dashes, starting with a letter or digit', () => {
  for (const valid of ['spyria', 'spyria-prod', 'acme2', '2nd-site']) expect(deploymentOf(valid)).toBe(valid)
  for (const invalid of ['Spyria', 'spyria_prod', '-spyria', 'spyria prod', 'spyria.prod', 'spyria/prod'])
    expect(() => deploymentOf(invalid)).toThrow('SPYRIA_DEPLOYMENT must be lowercase letters, digits and dashes')
})
