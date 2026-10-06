import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { ReactNode } from 'react'

for (const [name, language] of Object.entries({ bash, css, diff, json, python, sql, typescript, xml, yaml }))
  hljs.registerLanguage(name, language)

const reactNodeOf = (node: ChildNode, key: number): ReactNode =>
  node instanceof Element ? (
    <span key={key} className={node.className}>
      {[...node.childNodes].map(reactNodeOf)}
    </span>
  ) : (
    node.textContent
  )

export const highlightedCode = (code: string, language: string | undefined) => {
  const html = hljs.getLanguage(language ?? '')
    ? hljs.highlight(code, { language: language ?? '' }).value
    : hljs.highlightAuto(code).value
  return [...new DOMParser().parseFromString(html, 'text/html').body.childNodes].map(reactNodeOf)
}
