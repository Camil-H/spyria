import { SignInScreen } from '@spyria/workspace'
import { createRoot } from 'react-dom/client'
import { createWorkspaceWithPopup, loadAuthMode, loadSessions, signInWithPopup } from './app/auth.ts'
import { createApp } from './app/factory.ts'
import './app/styles.css'
import { App } from './app/Shell.tsx'

const root = createRoot(document.getElementById('root') as HTMLElement)

const start = async () => {
  const { userId, sessions, deployment } = await loadSessions()
  const [defaultSession] = sessions
  if (userId && defaultSession)
    return root.render(<App app={await createApp(userId, defaultSession.workspaceId, sessions, deployment)} />)
  const startWhenSignedIn = async (result: Awaited<ReturnType<typeof signInWithPopup>>) => {
    if (result.status === 'signed_in') await start()
    return result
  }
  const { authMode, canCreateWorkspace } = await loadAuthMode()
  root.render(
    <SignInScreen
      isEmailFirst={authMode === 'sso'}
      canCreateWorkspace={canCreateWorkspace}
      signIn={async (email) => startWhenSignedIn(await signInWithPopup({ email }))}
      createWorkspace={async (form) => startWhenSignedIn(await createWorkspaceWithPopup(form))}
    />,
  )
}

await start()
