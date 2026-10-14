const backgroundFeaturesOff = `[analytics]
enabled = false

[feedback]
enabled = false

[features]
plugins = false
remote_plugin = false
apps = false
`

const subscriptionConfig = `forced_login_method = "chatgpt"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

${backgroundFeaturesOff}`

export const codexSubscriptionCommand = [
  'env',
  `HQ_CODEX_CONFIG=${subscriptionConfig}`,
  'sh',
  '-c',
  'set -e; printf %s "$HQ_CODEX_CONFIG" > "$HOME/.codex/config.toml.$$"; mv "$HOME/.codex/config.toml.$$" "$HOME/.codex/config.toml"; exec codex-acp',
]
