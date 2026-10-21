export const defaultDeployment = 'spyria'
const deploymentPattern = /^[a-z0-9][a-z0-9-]*$/

export const deploymentOf = (name: string | undefined) => {
  if (!name) return defaultDeployment
  if (!deploymentPattern.test(name))
    throw new Error('SPYRIA_DEPLOYMENT must be lowercase letters, digits and dashes, starting with a letter or digit')
  return name
}

export const hostContainerOf = (deployment: string) => `${deployment}-host`
