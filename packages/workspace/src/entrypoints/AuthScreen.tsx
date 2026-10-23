import type { ReactNode } from 'react'
import { SpiresBackground } from './SpiresBackground.tsx'

export const AuthScreen = ({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) => (
  <main className="relative isolate flex min-h-screen flex-col items-center justify-center overflow-hidden bg-app p-6 text-ink">
    <SpiresBackground />
    <section className="relative flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-line bg-raised/75 p-8 shadow-xl backdrop-blur-md">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-[0.3em] text-muted uppercase">Spyria</p>
        <h1 className="text-2xl font-medium">{title}</h1>
        {description && <p className="text-sm text-muted">{description}</p>}
      </header>
      {children}
    </section>
  </main>
)
