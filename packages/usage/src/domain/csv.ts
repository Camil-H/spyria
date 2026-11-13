export const csvFieldOf = (text: string) => {
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText
}
