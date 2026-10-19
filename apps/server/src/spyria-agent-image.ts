export const readSpyriaAgentImage = async () =>
  process.env.SPYRIA_AGENT_IMAGE ||
  (
    await Bun.file(new URL('../../agent/image-id', import.meta.url))
      .text()
      .catch(() => '')
  ).trim() ||
  undefined
