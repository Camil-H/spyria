export const toolNamePartsOf = (toolName: string) => {
  const separator = toolName.indexOf('-')
  return separator === -1
    ? { server: toolName, tool: '' }
    : { server: toolName.slice(0, separator), tool: toolName.slice(separator + 1) }
}
