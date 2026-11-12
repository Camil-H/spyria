const disclosureContact = 'mailto:camil@spyria.dev'
const disclosurePolicy = 'https://github.com/Camil-H/spyria/blob/develop/SECURITY.md'
const validityMilliseconds = 180 * 24 * 60 * 60 * 1000

export const securityTxtPath = '/.well-known/security.txt'

export const securityTxtOf = (now: Date) =>
  [
    `Contact: ${disclosureContact}`,
    `Expires: ${new Date(now.getTime() + validityMilliseconds).toISOString()}`,
    `Policy: ${disclosurePolicy}`,
    'Preferred-Languages: en',
    '',
  ].join('\n')
