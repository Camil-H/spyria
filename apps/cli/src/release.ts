export const repository = 'Camil-H/spyria'
export const defaultImages = 'ghcr.io/camil-h'
export const cliVersion = process.env.SPYRIA_CLI_VERSION || 'dev'

export const releaseFileUrlOf = (version: string, path: string) =>
  `https://raw.githubusercontent.com/${repository}/v${version}/${path}`
export const releaseNotesUrlOf = (version: string) => `https://github.com/${repository}/releases/tag/v${version}`

export const latestVersion = async () => {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub did not name the latest release (${response.status})`)
  const { tag_name: tag } = (await response.json()) as { tag_name: string }
  return tag.replace(/^v/, '')
}
