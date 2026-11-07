export type Flags = { values: Record<string, string>; switches: Set<string>; positionals: string[] }

export const parseFlags = (givenArguments: readonly string[]): Flags => {
  const flags: Flags = { values: {}, switches: new Set(), positionals: [] }
  for (let index = 0; index < givenArguments.length; index++) {
    const argument = givenArguments[index] ?? ''
    if (!argument.startsWith('--')) {
      flags.positionals.push(argument)
      continue
    }
    const [name = '', inlineValue] = argument.slice(2).split(/=(.*)/s)
    const next = givenArguments[index + 1]
    if (inlineValue !== undefined) flags.values[name] = inlineValue
    else if (next !== undefined && !next.startsWith('--')) {
      flags.values[name] = next
      index++
    } else flags.switches.add(name)
  }
  return flags
}

export const askerOf = (flags: Flags, isUnattended = flags.switches.has('unattended')) => {
  const ask = (name: string, question: string, fallback = '') => {
    const given = flags.values[name]
    if (given !== undefined) return given.trim()
    if (isUnattended) return fallback
    return (prompt(fallback ? `${question} [${fallback}]` : question) ?? '').trim() || fallback
  }
  const choose = <Choice extends string>(
    name: string,
    question: string,
    choices: readonly Choice[],
    fallback: Choice,
  ) => {
    const answer = ask(name, `${question} (${choices.join(' or ')})`, fallback)
    if (!choices.includes(answer as Choice)) throw new Error(`--${name} must be ${choices.join(' or ')}`)
    return answer as Choice
  }
  const require = (name: string, question: string, fallback = '') => {
    const answer = ask(name, question, fallback)
    if (answer === '') throw new Error(`--${name} is required`)
    return answer
  }
  const given = (name: string) => flags.values[name] !== undefined
  return { ask, choose, require, given }
}

export const composeArgumentsOf = (afterCommand: readonly string[]) => {
  const folderAt = afterCommand.findIndex((argument) => argument === '--folder' || argument.startsWith('--folder='))
  if (folderAt === -1) return [...afterCommand]
  const width = afterCommand[folderAt]?.includes('=') ? 1 : 2
  return afterCommand.toSpliced(folderAt, width)
}
