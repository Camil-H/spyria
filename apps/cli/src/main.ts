import { commandsOf } from './command-table.ts'
import { parseFlags } from './flags.ts'
import { cliVersion } from './release.ts'

const usage = `spyria ${cliVersion}: install and run Spyria on this machine

  spyria setup                     ask the questions, write ~/spyria and start Spyria (--unattended takes flags only)
  spyria setup --cloud aws|azure|gcp
                                   write an OpenTofu configuration of the managed services and apply it
  spyria upgrade [version]         back up, then run the given or latest release
  spyria backup [--keep 7]         dump both databases into backups/, keeping the newest
  spyria restore <file> [--yes]    back up the database it replaces, then restore a dump from backups/ (asks first
                                   unless --yes)
  spyria doctor                    check Docker, the services, the server's start check, the disk,
                                   the .env mode, its credentials and the published ports
  spyria setup-link                print the link that creates the first workspace
  spyria compose <arguments>       run docker compose on the install, for example spyria compose logs -f server

Setup flags, each a question it then skips (with --cloud: --region, --project, --subscription, --dns-zone,
--dns-zone-resource-group, --route53-zone-id, --certificate-arn, --size, --bind-hostname yes|no): --name, --hostname,
--google-client-id, --microsoft-client-id (create to register it with az), --oidc-issuer with --oidc-client-id,
--provider cloudflare-access|microsoft|okta|google|other|skip with --owner-email or --okta-url, --version, --images,
--port, --no-host (no runtime host on this machine; kept when you set up again), --host (turn it back on; once a
workspace exists, with the command of Add runtime host), --no-start, --unattended (no question at all).

Secrets are never flags, so they stay out of your shell history and process list: setup asks for them, or reads them
from SPYRIA_SETUP_CLOUDFLARE_TOKEN (Account Cloudflare Tunnel Edit, Zone DNS Edit, Zone Read), SPYRIA_SETUP_GOOGLE_CLIENT_SECRET,
SPYRIA_SETUP_MICROSOFT_CLIENT_SECRET, SPYRIA_SETUP_OIDC_CLIENT_SECRET, SPYRIA_SETUP_OKTA_TOKEN and
SPYRIA_SETUP_HOST_CLAIM_URL (the command of Add runtime host). A saved secret is never shown;
an empty answer keeps it.
A - answer removes a sign-in app, or a saved optional answer with --cloud. --provider cloudflare-access needs the
Cloudflare token to also hold Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups
Edit, Email Routing Addresses Edit, Zone Email Routing Rules Edit and Zone DNS Edit.

Every command takes --folder <path> (default ~/spyria, or the current folder when it holds an install).`

const flags = parseFlags(process.argv.slice(2))
const [command] = flags.positionals
const commands = commandsOf(flags, process.argv)
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
