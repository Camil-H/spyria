import { type Cloud, clouds, setupCloud } from './cloud.ts'
import { backup, doctor, installFolderOf, installIn, printSetupLink, restore, upgrade } from './commands.ts'
import { runCompose } from './compose.ts'
import { composeArgumentsOf, type Flags } from './flags.ts'
import { cliVersion } from './release.ts'
import { setup } from './setup.ts'

export const commandsOf = (flags: Flags, commandLine: readonly string[]): Record<string, () => unknown> => {
  const folder = installFolderOf(flags)
  return {
    setup: () => {
      const cloud = flags.values.cloud
      if (cloud === undefined) return setup(flags)
      if (!clouds.includes(cloud as Cloud)) throw new Error('--cloud is aws, azure or gcp')
      return setupCloud(flags, cloud as Cloud)
    },
    upgrade: () => upgrade(installIn(folder), flags),
    backup: () => backup(installIn(folder), flags),
    restore: () => restore(installIn(folder), flags),
    doctor: () => {
      if (!doctor(installIn(folder))) process.exitCode = 1
    },
    'setup-link': () => printSetupLink(installIn(folder)),
    version: () => console.log(cliVersion),
    compose: () => {
      process.exitCode =
        runCompose(installIn(folder), composeArgumentsOf(commandLine.slice(commandLine.indexOf('compose') + 1))) ?? 1
    },
  }
}
