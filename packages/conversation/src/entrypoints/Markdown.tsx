import { CopyButton, focusRing } from '@spyria/ui'
import { Children, memo, type ReactElement, type ReactNode, use, useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isRuntimeMediaPath } from '../domain/attachments.ts'
import { mentionSegmentsOf } from '../domain/mentions.ts'
import { imageCountOf, streamedBlocksOf } from '../domain/streamed-markdown.ts'
import { RuntimeMedia } from './Media.tsx'
import { LoadedRemoteImagesContext } from './providers.tsx'

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number } }
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const autoLoadedImagesPerMessage = 4
const onDemandProperty = 'data-on-demand'

const tokenColors =
  '[&_.hljs-keyword]:text-code-keyword [&_.hljs-string]:text-code-string [&_.hljs-number]:text-code-number [&_.hljs-comment]:text-muted [&_.hljs-title]:text-code-title [&_.hljs-built_in]:text-code-built-in'

const rawHtmlAsText = () => (tree: MarkdownNode) => {
  const asText = (node: MarkdownNode) => {
    if (node.type === 'html') node.type = 'text'
    node.children?.forEach(asText)
  }
  asText(tree)
}

const underlineFromUnderscores = () => (tree: MarkdownNode, file: { value: unknown }) => {
  const source = String(file.value)
  const underline = (node: MarkdownNode) => {
    if (node.type === 'strong' && source.startsWith('__', node.position?.start.offset ?? -1))
      node.data = { ...node.data, hName: 'u' }
    node.children?.forEach(underline)
  }
  underline(tree)
}

const lineBreaksKept = () => (tree: MarkdownNode) => {
  const withBreaks = (node: MarkdownNode): MarkdownNode => ({
    ...node,
    children: node.children?.flatMap((child) =>
      child.type === 'text' && child.value?.includes('\n')
        ? child.value
            .split(/\r?\n|\r/)
            .flatMap((line, index) => [...(index > 0 ? [{ type: 'break' }] : []), { type: 'text', value: line }])
        : [withBreaks(child)],
    ),
  })
  tree.children = withBreaks(tree).children
}

const laterImagesOnDemand = (autoLoadedImages: number) => () => (tree: MarkdownNode) => {
  let imageCount = 0
  const markLaterImages = (node: MarkdownNode) => {
    if (node.type === 'image' && ++imageCount > autoLoadedImages)
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, [onDemandProperty]: 'true' } }
    node.children?.forEach(markLaterImages)
  }
  markLaterImages(tree)
}

const boldMentions = (names: readonly string[]) => () => (tree: MarkdownNode) => {
  const withMentions = (node: MarkdownNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text') {
        withMentions(child)
        return [child]
      }
      return mentionSegmentsOf(child.value ?? '', names).map(({ text, isMention }) =>
        isMention ? { type: 'strong', children: [{ type: 'text', value: text }] } : { type: 'text', value: text },
      )
    })
  }
  if (names.length > 0) withMentions(tree)
}

const decodedPathOf = (source: string) => {
  try {
    return decodeURIComponent(source)
  } catch {
    return source
  }
}

const domainOf = (url: string | undefined) => {
  try {
    return new URL(url ?? '').hostname
  } catch {
    return ''
  }
}

const RemoteImage = ({ src, alt }: { src?: string; alt?: string }) => {
  const loadedInChat = use(LoadedRemoteImagesContext)
  const [isLoadedHere, setIsLoadedHere] = useState(false)
  const load = () => {
    setIsLoadedHere(true)
    if (src) loadedInChat?.load(src)
  }
  return isLoadedHere || (src !== undefined && loadedInChat?.sources.has(src)) ? (
    <img src={src} alt={alt} className="max-w-full rounded-md" />
  ) : (
    <button
      type="button"
      onClick={load}
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
  img: ({ src, alt, ...properties }) => {
    const source = typeof src === 'string' ? src : undefined
    const remoteImage = <RemoteImage src={source} alt={alt} />
    return source && isRuntimeMediaPath(source) ? (
      <RuntimeMedia
        path={decodedPathOf(source)}
        alt={alt ?? ''}
        isOnDemand={onDemandProperty in properties}
        fallback={remoteImage}
      />
    ) : (
      remoteImage
    )
  },
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

type MarkdownProps = { text: string; keepsLineBreaks?: boolean; mentionNames?: readonly string[] }
type MarkdownBlocksProps = MarkdownProps & { autoLoadedImages?: number }

const markdownClassName =
  'flex flex-col gap-2 text-sm [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-hover [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:text-xs'

const MarkdownBlocks = memo(
  ({
    text,
    keepsLineBreaks = false,
    mentionNames = [],
    autoLoadedImages = autoLoadedImagesPerMessage,
  }: MarkdownBlocksProps) => (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        rawHtmlAsText,
        underlineFromUnderscores,
        laterImagesOnDemand(autoLoadedImages),
        ...(keepsLineBreaks ? [lineBreaksKept] : []),
        boldMentions(mentionNames),
      ]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  ),
)

export const StreamedMarkdown = ({ text, ...options }: MarkdownProps) => {
  const { completed, tail } = streamedBlocksOf(text)
  let imagesBefore = 0
  return (
    <div className={markdownClassName}>
      {[...completed, tail].map((block) => {
        const autoLoadedImages = Math.max(0, autoLoadedImagesPerMessage - imagesBefore)
        imagesBefore += imageCountOf(block.text)
        return <MarkdownBlocks key={block.offset} text={block.text} autoLoadedImages={autoLoadedImages} {...options} />
      })}
    </div>
  )
}

const Markdown = (props: MarkdownProps) => (
  <div className={markdownClassName}>
    <MarkdownBlocks {...props} />
  </div>
)

export default Markdown
