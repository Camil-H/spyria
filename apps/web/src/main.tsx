import { Toast } from '@spyria/ui'
import { SignInScreen, WorkspaceLoadingScreen } from '@spyria/workspace'
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
const pageUrl = new URL(location.href)
const domainVerification = pageUrl.searchParams.get('domainVerification')
pageUrl.searchParams.delete('domainVerification')
history.replaceState(history.state, '', pageUrl)
const domainVerificationToast = (ssoSettingsPath?: string) =>
  domainVerification && (
    <Toast>
      {domainVerification !== 'invalid' ? (
        `Domain ${domainVerification} verified`
      ) : (
        <>
          This verification link is invalid or expired. Send a new one from{' '}
          {ssoSettingsPath ? (
            <a href={ssoSettingsPath} className="underline">
              Workspace settings › Setup SSO
            </a>
          ) : (
            'Workspace settings › Setup SSO'
          )}
          .
        </>
      )}
    </Toast>
  )

const slowWorkspaceLoadMilliseconds = 10_000
const sessionEndedNotice = 'Your session ended while your workspace was opening. Sign in again.'
const sessionMissing = {
  status: 'refused',
  message: 'Sign-in finished without opening your workspace. Try again.',
} as const

const openApp = async () => {
  const { userId, sessions, deployment } = await loadSessions()
  const [defaultSession] = sessions
  if (!userId || !defaultSession) return 'signed_out'
  const [{ createApp }, { App }] = await (earlyAppModules ?? appModules())
  rememberSignedIn()
  const slowLoadTimer = setTimeout(() => root.render(<WorkspaceLoadingScreen />), slowWorkspaceLoadMilliseconds)
  const app = await createApp(userId, defaultSession.workspaceId, sessions, deployment).finally(() =>
    clearTimeout(slowLoadTimer),
  )
  if (!app) return 'session_ended'
  root.render(
    <>
      <App app={app} />
      {domainVerificationToast(`/w/${defaultSession.workspaceId}/settings/sso`)}
    </>,
  )
  return 'opened'
}

const openAppWhenSignedIn = async (result: Awaited<ReturnType<typeof signInWithPopup>>) => {
  if (result.status !== 'signed_in') return result
  const opened = await openApp()
  if (opened === 'opened') return result
  if (opened !== 'session_ended') return sessionMissing
  await showSignIn(sessionEndedNotice)
  return { status: 'refused', message: sessionEndedNotice } as const
}

const showSignIn = async (notice?: string) => {
  const { authMode, canCreateWorkspace, instanceApps } = await loadAuthMode()
  root.render(
    <>
      <SignInScreen
        isEmailFirst={authMode === 'sso'}
        canCreateWorkspace={canCreateWorkspace}
        instanceApps={instanceApps}
        notice={notice}
        signIn={async (email) => openAppWhenSignedIn(await signInWithPopup({ email }))}
        createWorkspace={async (form) => openAppWhenSignedIn(await createWorkspaceWithPopup(form))}
      />
      {domainVerificationToast()}
    </>,
  )
}

const opened = await openApp()
if (opened !== 'opened') await showSignIn(opened === 'session_ended' ? sessionEndedNotice : undefined)
