const lineStyles = {
  added: { marker: '+', className: 'bg-added' },
  removed: { marker: '-', className: 'bg-removed' },
  context: { marker: ' ', className: '' },
}

export const DiffView = ({ lines }: { lines: readonly { kind: keyof typeof lineStyles; text: string }[] }) => (
  <section aria-label="Diff" className="overflow-x-auto rounded-md border border-line font-mono text-xs">
    {[...lines.entries()].map(([lineNumber, line]) => (
      <div key={lineNumber} className={`whitespace-pre px-2 py-0.5 ${lineStyles[line.kind].className}`}>
        {lineStyles[line.kind].marker} {line.text}
      </div>
    ))}
  </section>
)
