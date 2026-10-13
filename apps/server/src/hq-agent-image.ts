export const readHqAgentImage = async () =>
  process.env.HQ_AGENT_IMAGE ||
  (
    await Bun.file(new URL('../../agent/image-id', import.meta.url))
      .text()
      .catch(() => '')
  ).trim() ||
  undefined
