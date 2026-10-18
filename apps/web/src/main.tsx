import { SignInScreen } from '@hq/workspace'
import { createRoot } from 'react-dom/client'
import { loadAuthMode, loadSessions, signInWithPopup } from './app/auth.ts'
import { createApp } from './app/factory.ts'
import './app/styles.css'
import { App } from './app/Shell.tsx'

const root = createRoot(document.getElementById('root') as HTMLElement)

const start = async () => {
  const { userId, sessions } = await loadSessions()
  const [defaultSession] = sessions
  if (userId && defaultSession)
    return root.render(<App app={await createApp(userId, defaultSession.workspaceId, sessions)} />)
  const signIn = async (email?: string) => {
    const result = await signInWithPopup({ email })
    if (result.status === 'signed_in') await start()
    return result
  }
  root.render(<SignInScreen isEmailFirst={(await loadAuthMode()) === 'sso'} signIn={signIn} />)
}

await start()
