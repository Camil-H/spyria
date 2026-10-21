import { SignInScreen } from '@spyria/workspace'
import { createRoot } from 'react-dom/client'
import { createWorkspaceWithPopup, loadAuthMode, loadSessions, signInWithPopup } from './app/auth.ts'
import './app/styles.css'

const root = createRoot(document.getElementById('root') as HTMLElement)
const signedInBeforeKey = 'spyria.signed-in-before'
const appModules = () => Promise.all([import('./app/factory.ts'), import('./app/Shell.tsx')])
const hasSignedInBefore = () => {
  try {
    return localStorage.getItem(signedInBeforeKey) === '1'
  } catch {
    return false
  }
}
const rememberSignedIn = () => {
  try {
    localStorage.setItem(signedInBeforeKey, '1')
  } catch {}
}
const earlyAppModules = hasSignedInBefore() ? appModules() : undefined

const start = async () => {
  const { userId, sessions, deployment } = await loadSessions()
  const [defaultSession] = sessions
  if (userId && defaultSession) {
    const [{ createApp }, { App }] = await (earlyAppModules ?? appModules())
    rememberSignedIn()
    return root.render(<App app={await createApp(userId, defaultSession.workspaceId, sessions, deployment)} />)
  }
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
