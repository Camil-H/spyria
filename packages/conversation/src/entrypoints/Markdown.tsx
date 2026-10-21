import { CopyButton, focusRing } from '@spyria/ui'
import { Children, type ReactElement, type ReactNode, useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

type MarkdownNode = { type: string; children?: MarkdownNode[] }

const tokenColors =
  '[&_.hljs-keyword]:text-[light-dark(#7c3aed,#c4b5fd)] [&_.hljs-string]:text-[light-dark(#15803d,#86efac)] [&_.hljs-number]:text-[light-dark(#b45309,#fcd34d)] [&_.hljs-comment]:text-muted [&_.hljs-title]:text-[light-dark(#1d4ed8,#93c5fd)] [&_.hljs-built_in]:text-[light-dark(#be123c,#fda4af)]'

const rawHtmlAsText = () => (tree: MarkdownNode) => {
  const asText = (node: MarkdownNode) => {
    if (node.type === 'html') node.type = 'text'
    node.children?.forEach(asText)
  }
  asText(tree)
}

const domainOf = (url: string | undefined) => {
  try {
    return new URL(url ?? '').hostname
  } catch {
    return ''
  }
}

const RemoteImage = ({ src, alt }: { src?: string; alt?: string }) => {
  const [isLoaded, setIsLoaded] = useState(false)
  return isLoaded ? (
    <img src={src} alt={alt} className="max-w-full rounded-md" />
  ) : (
    <button
      type="button"
      onClick={() => setIsLoaded(true)}
      className={`rounded-md border border-dashed border-line px-2 py-1 text-xs text-muted hover:bg-hover ${focusRing}`}
    >
      Load image from {domainOf(src) || 'this message'}
    </button>
  )
}

let highlightModule: Promise<typeof import('./highlight.tsx')> | undefined
const loadHighlight = () => {
  highlightModule ??= import('./highlight.tsx')
  return highlightModule
}

const CodeBlock = ({ code, language }: { code: string; language: string | undefined }) => {
  const [highlighted, setHighlighted] = useState<ReactNode>()
  useEffect(() => {
    let isCurrent = true
    void loadHighlight().then(({ highlightedCode }) => {
      if (isCurrent) setHighlighted(highlightedCode(code, language))
    })
    return () => {
      isCurrent = false
    }
  }, [code, language])
  return (
    <div className="relative">
      <CopyButton
        text={code}
        label="Copy code"
        className={`absolute top-1 right-1 rounded-md px-2 py-0.5 text-xs text-muted hover:bg-hover ${focusRing}`}
      />
      <pre className="overflow-x-auto rounded-md border border-line bg-app p-2 text-xs">
        <code className={tokenColors}>{highlighted ?? code}</code>
      </pre>
    </div>
  )
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-link underline">
      {children} <span className="text-xs text-muted">({domainOf(href)})</span>
    </a>
  ),
  img: ({ src, alt }) => <RemoteImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  pre: ({ children }) => {
    const code = Children.only(children) as ReactElement<{ className?: string; children?: ReactNode }>
    return (
      <CodeBlock
        code={String(code.props.children ?? '').replace(/\n$/, '')}
        language={code.props.className?.replace('language-', '')}
      />
    )
  },
}

const Markdown = ({ text }: { text: string }) => (
  <div className="flex flex-col gap-2 text-sm [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
    <ReactMarkdown remarkPlugins={[remarkGfm, rawHtmlAsText]} components={components}>
      {text}
    </ReactMarkdown>
  </div>
)

export default Markdown
