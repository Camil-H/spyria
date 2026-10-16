export const waitFor = async (isDone: () => boolean) => {
  for (const deadline = Date.now() + 5000; !isDone() && Date.now() < deadline; ) await Bun.sleep(5)
}

export const nextFrameOf = async <Frame extends Record<string, unknown>>(sent: Frame[], type: string) => {
  await waitFor(() => sent.some((frame) => frame.type === type))
  const index = sent.findIndex((frame) => frame.type === type)
  if (index < 0) throw new Error(`No ${type} frame`)
  return sent.splice(index, 1)[0] as Frame
}
