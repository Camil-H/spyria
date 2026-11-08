import { type Cloud, clouds, setupCloud } from './cloud.ts'
import {
  backup,
  changeSignInApp,
  doctor,
  installFolderOf,
  printSetupLink,
  restore,
  upgrade,
  verifyDomain,
} from './commands.ts'
import { runCompose } from './compose.ts'
import { composeArgumentsOf, parseFlags } from './flags.ts'
import { cliVersion } from './release.ts'
import { setup } from './setup.ts'

const usage = `spyria ${cliVersion}: install and run Spyria on this machine

  spyria setup                     ask the questions, write ~/spyria and start Spyria (--unattended takes flags only)
  spyria setup --cloud aws|azure|gcp
                                   write an OpenTofu configuration of the managed services and apply it
  spyria upgrade [version]         back up, then run the given or latest release
  spyria backup [--keep 7]         dump both databases into backups/, keeping the newest
  spyria restore <file>            restore a dump from backups/
  spyria doctor                    check Docker, the services, the server's start check and the disk
  spyria setup-link                print the link that creates the first workspace
  spyria sign-in-app --client-id <id>
                                   change the sign-in app of every workspace joined by invited address (asks for the
                                   secret, or reads it from standard input)
  spyria verify-domain --workspace <id> --domain <domain>
                                   verify a workspace's email domain without mail
  spyria compose <arguments>       run docker compose on the install, for example spyria compose logs -f server

Setup flags, each a question it then skips (with --cloud: --region, --project, --subscription, --dns-zone,
--dns-zone-resource-group, --route53-zone-id, --certificate-arn, --size, --bind-hostname yes): --name, --hostname, --cloudflare-token (Account Cloudflare Tunnel Edit,
Zone DNS Edit, Zone Read), --join-by domain|invited-address, --google-client-id and --google-client-secret,
--microsoft-client-id and --microsoft-client-secret (create to register it with az), --provider
cloudflare-access|microsoft|okta|google|other|skip with --owner-email or --okta-url and --okta-token,
--mail skip|smtp|resend|keep with --smtp-url or --resend-key, --mail-from, --mail-test <address>, --version,
--images, --port, --no-host (no runtime host on this machine; kept when you set up again), --host (turn it back on), --no-start, --unattended (no question at all).
A - answer removes a sign-in app, or a saved optional answer with --cloud; --mail skip removes mail. --provider cloudflare-access and --mail resend need the
Cloudflare token to also hold Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups
Edit, Email Routing Addresses Edit, Zone Email Routing Rules Edit and Zone DNS Edit.

Every command takes --folder <path> (default ~/spyria, or the current folder when it holds an install).`

const flags = parseFlags(process.argv.slice(2))
const [command] = flags.positionals
const folder = installFolderOf(flags)
const commands: Record<string, () => unknown> = {
  setup: () => {
    const cloud = flags.values.cloud
    if (cloud === undefined) return setup(flags)
    if (!clouds.includes(cloud as Cloud)) throw new Error('--cloud is aws, azure or gcp')
    return setupCloud(flags, cloud as Cloud)
  },
  upgrade: () => upgrade(folder, flags),
  backup: () => backup(folder, flags),
  restore: () => restore(folder, flags),
  doctor: () => {
    if (!doctor(folder)) process.exitCode = 1
  },
  'setup-link': () => printSetupLink(folder),
  'verify-domain': () => verifyDomain(folder, flags),
  'sign-in-app': () => changeSignInApp(folder, flags),
  version: () => console.log(cliVersion),
  compose: () => {
    process.exitCode =
      runCompose(folder, composeArgumentsOf(process.argv.slice(process.argv.indexOf('compose') + 1))) ?? 1
  },
}
const run = command ? commands[command] : undefined
if (!run || flags.switches.has('help')) {
  console.log(usage)
  if (command && command !== 'help' && !flags.switches.has('help')) process.exitCode = 2
} else
  try {
    await run()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
