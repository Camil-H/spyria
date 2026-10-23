import { Toast } from '@spyria/ui'
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

const start = async () => {
  const { userId, sessions, deployment } = await loadSessions()
  const [defaultSession] = sessions
  if (userId && defaultSession) {
    const [{ createApp }, { App }] = await (earlyAppModules ?? appModules())
    rememberSignedIn()
    return root.render(
      <>
        <App app={await createApp(userId, defaultSession.workspaceId, sessions, deployment)} />
        {domainVerificationToast(`/w/${defaultSession.workspaceId}/settings/sso`)}
      </>,
    )
  }
  const startWhenSignedIn = async (result: Awaited<ReturnType<typeof signInWithPopup>>) => {
    if (result.status === 'signed_in') await start()
    return result
  }
  const { authMode, canCreateWorkspace, instanceApps } = await loadAuthMode()
  root.render(
    <>
      <SignInScreen
        isEmailFirst={authMode === 'sso'}
        canCreateWorkspace={canCreateWorkspace}
        instanceApps={instanceApps}
        signIn={async (email) => startWhenSignedIn(await signInWithPopup({ email }))}
        createWorkspace={async (form) => startWhenSignedIn(await createWorkspaceWithPopup(form))}
      />
      {domainVerificationToast()}
    </>,
  )
}

await start()
