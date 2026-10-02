import { createContext, type ReactNode, use } from 'react'

type PromptAccess = { canPrompt: boolean; blockedNotice: ReactNode }

const PromptAccessContext = createContext<PromptAccess>({ canPrompt: false, blockedNotice: null })

export const PromptAccessProvider = ({
  canPrompt,
  blockedNotice,
  children,
}: PromptAccess & { children: ReactNode }) => (
  <PromptAccessContext value={{ canPrompt, blockedNotice }}>{children}</PromptAccessContext>
)

export const usePromptAccess = () => use(PromptAccessContext)
