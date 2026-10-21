import { hostContainerOf } from './deployment.ts'

const claudeCodeSettings = [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
  'CLAUDE_CODE_MAX_RETRIES=0',
]

const codexSubscriptionConfig = `forced_login_method = "chatgpt"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[analytics]
enabled = false

[feedback]
enabled = false

[features]
plugins = false
remote_plugin = false
apps = false
`

export const harnesses = {
  'claude-code': {
    name: 'Claude Code',
    launch: ['env', ...claudeCodeSettings, 'claude-agent-acp'],
  },
  codex: {
    name: 'Codex',
    launch: [
      'env',
      `SPYRIA_CODEX_CONFIG=${codexSubscriptionConfig}`,
      'sh',
      '-c',
      'set -e; printf %s "$SPYRIA_CODEX_CONFIG" > "$HOME/.codex/config.toml.$$"; mv "$HOME/.codex/config.toml.$$" "$HOME/.codex/config.toml"; exec codex-acp',
    ],
  },
} as const satisfies Record<string, { name: string; launch: readonly string[] }>

export type HarnessId = keyof typeof harnesses
export const harnessIds = Object.keys(harnesses) as HarnessId[]
export const defaultHarness: HarnessId = 'claude-code'
export const harnessOf = (harness: HarnessId | null) => harness ?? defaultHarness

export const signInCommandOf = (harness: HarnessId, deployment: string) =>
  `docker exec -it ${hostContainerOf(deployment)} spyria-host login ${harness}`
export const signInNoticeOf = (harness: HarnessId, deployment: string) =>
  `Sign in to ${harnesses[harness].name} on your machine: ${signInCommandOf(harness, deployment)}`
export const expiredNoticeOf = (harness: HarnessId) =>
  `Authentication required — sign in to ${harnesses[harness].name} again`
