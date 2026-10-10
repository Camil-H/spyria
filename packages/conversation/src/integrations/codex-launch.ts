const globalConfig = `model_provider = "off"
check_for_update_on_startup = false

[model_providers.off]
name = "Off"
base_url = "http://127.0.0.1:9/v1"
env_key = "HQ_CODEX_OFF"
wire_api = "responses"

[analytics]
enabled = false

[feedback]
enabled = false

[features]
plugins = false
remote_plugin = false
apps = false
`

const modelCatalogScript = `const catalog = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const preset = catalog.models.find((model) => model.slug === 'gpt-5.6-sol')
catalog.models.push({
  ...preset,
  slug: 'gpt-6.1-sol',
  display_name: 'GPT-6.1-Sol',
  context_window: 1050000,
  max_context_window: 1050000,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: preset.supported_reasoning_levels.filter(({ effort }) => effort !== 'ultra'),
})
process.stdout.write(JSON.stringify(catalog))`

const launcher = `set -e
mkdir -p "$HOME/.codex"
codex-acp cli debug models --bundled | node -e "$HQ_CODEX_MODEL_CATALOG_SCRIPT" > "$HOME/.codex/models.json"
printf 'model_catalog_json = "%s"\\n%s' "$HOME/.codex/models.json" "$HQ_CODEX_GLOBAL_CONFIG" > "$HOME/.codex/config.toml"
exec codex-acp`

export const codexCommandOf = (relayUrl: string, model: string) => [
  'env',
  `CODEX_CONFIG=${JSON.stringify({
    model,
    model_providers: {
      hq: {
        name: 'HQ',
        base_url: relayUrl,
        env_key: 'OPENAI_API_KEY',
        wire_api: 'responses',
        supports_websockets: false,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
  })}`,
  'MODEL_PROVIDER=hq',
  `HQ_CODEX_GLOBAL_CONFIG=${globalConfig}`,
  `HQ_CODEX_MODEL_CATALOG_SCRIPT=${modelCatalogScript}`,
  'sh',
  '-c',
  launcher,
]
