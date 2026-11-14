import { ServerUnreachableScreen, SignInScreen, WorkspaceLoadingScreen } from '@spyria/workspace'
import { createRoot } from 'react-dom/client'
import {
  createWorkspaceOfAccount,
  loadAuthMode,
  loadSessions,
  signInWithEmail,
  signInWithPopup,
  submitInPopup,
} from './app/auth.ts'
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
const slowWorkspaceLoadMilliseconds = 10_000
const sessionEndedNotice = 'Your session ended while your workspace was opening. Sign in again.'
const sessionMissing = {
  status: 'refused',
  message: 'Sign-in finished without opening your workspace. Try again.',
} as const

const openApp = async () => {
  const loaded = await loadSessions()
  if (!loaded.userId) return 'signed_out'
  const { userId, sessions, ...instance } = loaded
  const [defaultSession] = sessions
  if (!defaultSession) return 'signed_out'
  const [{ createApp }, { App }] = await (earlyAppModules ?? appModules())
  rememberSignedIn()
  const slowLoadTimer = setTimeout(() => root.render(<WorkspaceLoadingScreen />), slowWorkspaceLoadMilliseconds)
  const app = await createApp(userId, defaultSession.workspaceId, sessions, instance).finally(() =>
    clearTimeout(slowLoadTimer),
  )
  if (!app) return 'session_ended'
  root.render(<App app={app} />)
  return 'opened'
}

const openAppWhenSignedIn = async (result: Awaited<ReturnType<typeof signInWithEmail>>) => {
  if (result.status !== 'signed_in') return result
  const opened = await openApp()
  if (opened === 'opened') return result
  if (opened !== 'session_ended') return sessionMissing
  await showSignIn(sessionEndedNotice)
  return { status: 'refused', message: sessionEndedNotice } as const
}

const showSignIn = async (notice?: string) => {
  const setupToken = new URLSearchParams(location.search).get('setup') ?? undefined
  const { authMode, isBeingSetUp, canCreateWorkspace, accountProviders, instanceApps } = await loadAuthMode(setupToken)
  root.render(
    <SignInScreen
      isEmailFirst={authMode === 'sso'}
      isBeingSetUp={isBeingSetUp}
      canCreateWorkspace={canCreateWorkspace}
      setupToken={setupToken}
      accountProviders={accountProviders}
      instanceApps={instanceApps}
      notice={notice}
      signInWithEmail={async (email) => openAppWhenSignedIn(await signInWithEmail(email))}
      signIn={async (target) => openAppWhenSignedIn(await signInWithPopup(target))}
      createFirstWorkspace={async (form) => openAppWhenSignedIn(await submitInPopup(form, '/auth/first-workspace'))}
      createWorkspace={(name) =>
        createWorkspaceOfAccount(name).then(
          () => openAppWhenSignedIn({ status: 'signed_in' }),
          (error: Error) => ({ status: 'refused', message: error.message }) as const,
        )
      }
    />,
  )
}

const boot = async () => {
  const opened = await openApp()
  if (opened !== 'opened') await showSignIn(opened === 'session_ended' ? sessionEndedNotice : undefined)
}

await boot().catch((error: unknown) => {
  console.error(error)
  root.render(<ServerUnreachableScreen />)
})
