const leadingTokenCharacters = /^[\w.-]+/

export const outputTailOf = (output: string, maximumCharacters: number) => {
  if (output.length <= maximumCharacters) return output
  return output.slice(-maximumCharacters).replace(leadingTokenCharacters, '')
}
