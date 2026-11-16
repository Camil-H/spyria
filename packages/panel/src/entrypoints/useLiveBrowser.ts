import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { useEffect, useRef, useState } from 'react'
import type { BrowserMessage, BrowserPage, BrowserState } from '../domain/browser.ts'
import type { BrowserConnection } from './commands.ts'
import { usePanelCommands } from './providers.tsx'

export type ShownFrame = Readonly<{ data: string; width: number; height: number }>

const saveDownload = ({ name, data }: { name: string; data: string }) => {
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([bytes]))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

export const useLiveBrowser = (workspaceId: WorkspaceId, chatId: ChatId) => {
  const { openBrowser } = usePanelCommands()
  const [state, setState] = useState<BrowserState>({ state: 'connecting' })
  const [frame, setFrame] = useState<ShownFrame>()
  const [page, setPage] = useState<BrowserPage>()
  const [notice, setNotice] = useState<string>()
  const [fileChooser, setFileChooser] = useState<{ multiple: boolean }>()
  const connection = useRef<BrowserConnection>(undefined)
  const [send] = useState(() => (message: object) => connection.current?.send(message))
  useEffect(() => {
    const receive = (message: BrowserMessage) => {
      if (message.type === 'state') return setState(message)
      if (message.type === 'frame') {
        setFrame(message)
        return send({ type: 'frame_ack' })
      }
      if (message.type === 'page') return setPage({ url: message.url, title: message.title })
      if (message.type === 'notice') return setNotice(message.text)
      if (message.type === 'file_chooser') return setFileChooser({ multiple: message.multiple })
      if (message.type === 'download') saveDownload(message)
    }
    const opened = openBrowser({ workspaceId, chatId }, receive)
    connection.current = opened
    return () => opened.close()
  }, [openBrowser, workspaceId, chatId, send])
  return {
    state,
    frame,
    page,
    notice,
    fileChooser,
    send,
    start: () => {
      setState({ state: 'starting' })
      send({ type: 'start' })
    },
    closeFileChooser: () => setFileChooser(undefined),
  }
}

export type LiveBrowser = ReturnType<typeof useLiveBrowser>
