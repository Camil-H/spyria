const commandRequest = /\b(?:by|try) running\b|(?:^|\s)run:?\s+`/i

export const asksToRunACommand = (line: string) => commandRequest.test(line)
