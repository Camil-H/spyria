import { toolConnectionOf } from './tool-calls.ts'

export type DiffLine = { kind: 'added' | 'removed' | 'context'; text: string }
export type ThoughtStep = { type: 'thought'; text: string; durationMilliseconds: number | null }
export type AgentStep =
  | ThoughtStep
  | {
      type: 'command'
      command: string
      exitCode: number | null
      durationMilliseconds: number | null
      output: string
      truncatedLines: number
    }
  | {
      type: 'file'
      operation: 'read' | 'create' | 'edit'
      path: string
      added: number
      removed: number
      diff: DiffLine[]
    }
  | {
      type: 'tool'
      name: string
      arguments: string
      result: string | null
      isError?: true
      connection?: { server: string; isReconnect: boolean }
    }
  | { type: 'plan'; items: { title: string; status: string }[] }
  | { type: 'error'; message: string; signIn?: string }
  | {
      type: 'question'
      questionId: string
      toolCallId?: string
      kind: 'question' | 'plan'
      questions?: AgentQuestion[]
      plan?: string
      answers?: Record<string, string | string[]>
      free?: Record<string, string>
      approved?: boolean
      answeredBy?: string
      closed?: 'stopped' | 'cancelled' | 'turn_end'
    }
export type AgentQuestion = {
  id: string
  header?: string
  text: string
  options: { value: string; label: string; description?: string }[]
  multi: boolean
  free: boolean
}
export type StepDelegation = { id: string; model: string; modelName: string; task: string; fallback?: string }
export type StoredStep = AgentStep & { thought?: ThoughtStep; delegation?: StepDelegation }
export type Fields = Record<string, unknown> | undefined

const keptOutputLines = 200
const workingDirectory = '/workspace/project/'

export const textOf = (content: unknown) =>
  Array.isArray(content) ? content.map((part) => String((part as Fields)?.text ?? '')).join('') : ''

export const keptOutputOf = (output: string) => {
  const lines = output.split('\n')
  return {
    output: lines.slice(-keptOutputLines).join('\n'),
    truncatedLines: Math.max(0, lines.length - keptOutputLines),
  }
}

const linesOf = (content: unknown) =>
  typeof content === 'string' && content !== '' ? content.replace(/\n$/, '').split('\n') : []

const contextLines = 3
const linesOfKind = (kind: DiffLine['kind'], lines: readonly string[]) => lines.map((text) => ({ kind, text }))

const lineDiffOf = (before: readonly string[], after: readonly string[]): DiffLine[] => {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++
  return [
    ...linesOfKind('context', before.slice(Math.max(0, prefix - contextLines), prefix)),
    ...linesOfKind('removed', before.slice(prefix, before.length - suffix)),
    ...linesOfKind('added', after.slice(prefix, after.length - suffix)),
    ...linesOfKind('context', after.slice(after.length - suffix).slice(0, contextLines)),
  ]
}

export const pathOf = (path: unknown) => String(path ?? '').replace(workingDirectory, '')

export const legacyToolCallStep = (command: string, output: string | null): StoredStep => ({
  type: 'command',
  command,
  exitCode: null,
  durationMilliseconds: null,
  output: output ?? '',
  truncatedLines: 0,
})

export const observedStep = (
  step: StoredStep,
  observation: Fields,
  durationMilliseconds: number,
): StoredStep | undefined => {
  if (step.type === 'command')
    return {
      ...step,
      command: typeof observation?.command === 'string' ? observation.command : step.command,
      exitCode: typeof observation?.exit_code === 'number' ? observation.exit_code : null,
      durationMilliseconds,
      ...keptOutputOf(textOf(observation?.content)),
    }
  if (step.type === 'file' && step.operation !== 'read') {
    const diff = lineDiffOf(linesOf(observation?.old_content), linesOf(observation?.new_content))
    const countOf = (kind: DiffLine['kind']) => diff.filter((line) => line.kind === kind).length
    return { ...step, added: countOf('added'), removed: countOf('removed'), diff }
  }
  if (step.type === 'tool') {
    const result = textOf(observation?.content)
    const connection = toolConnectionOf(result)
    return {
      ...step,
      result,
      ...(observation?.is_error === true && { isError: true }),
      ...(connection && { connection }),
    }
  }
  return undefined
}
