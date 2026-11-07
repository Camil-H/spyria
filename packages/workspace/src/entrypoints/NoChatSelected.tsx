import { ShortcutKeys } from '@spyria/ui'
import { useState } from 'react'
import { SpiresBackground } from './SpiresBackground.tsx'

const greetings = [
  'Quiet in here. Your agents are standing by.',
  'The agents are stretching. Give them something to do.',
  'Every good pull request starts with a chat.',
  'Nothing open yet. The best ideas start as a message.',
  'All caught up? Then it is a fine time to start something.',
]

const ShortcutHint = ({ keys, label }: { keys: string; label: string }) => (
  <span className="flex items-center gap-2">
    <span className="rounded-md border border-line bg-app px-1.5 py-0.5 text-xs">
      <ShortcutKeys keys={keys} />
    </span>
    {label}
  </span>
)

export const NoChatSelected = () => {
  const [greeting] = useState(() => greetings[Math.floor(Math.random() * greetings.length)])
  return (
    <div className="relative isolate flex h-full min-h-80 flex-col items-center justify-center overflow-hidden p-6">
      <div className="absolute inset-0 -z-10 opacity-50">
        <SpiresBackground />
      </div>
      <section className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-card-edge bg-raised/80 p-8 text-center shadow-xl shadow-card-glow backdrop-blur-md">
        <h2 className="text-xl font-medium">Select a chat</h2>
        <p className="text-sm text-muted">{greeting}</p>
        <div className="mt-2 flex flex-col items-start gap-1.5 text-sm text-muted">
          <ShortcutHint keys="c" label="Start a new chat" />
          <ShortcutHint keys="/" label="Search the workspace" />
        </div>
      </section>
    </div>
  )
}
