const wordBoundary = /\s/

export const outputTailOf = (output: string, maximumCharacters: number) => {
  if (output.length <= maximumCharacters) return output
  const tail = output.slice(-maximumCharacters)
  const boundary = tail.search(wordBoundary)
  return boundary === -1 ? '' : tail.slice(boundary + 1)
}
