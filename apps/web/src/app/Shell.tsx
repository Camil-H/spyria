import { StoreProvider } from '@hq/db'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { BrowserRouter, Link, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import { ConversationProvider } from '../conversation/entrypoints/providers.tsx'
import { ChatView, DraftIndicator, PromptAccessProvider } from '../conversation/surface.ts'
import { PanelProvider, PanelToggle, SidePanel } from '../panel/surface.ts'
import { ProfileView } from '../profile/entrypoints/ProfileView.tsx'
import { ProfileProvider, useHasLlmCredential } from '../profile/surface.ts'
import { WorkspaceProvider } from '../workspace/entrypoints/providers.tsx'
import { WorkspaceLayout } from '../workspace/entrypoints/WorkspaceLayout.tsx'
import type { Application } from './factory.ts'
import { SessionProvider } from './session.tsx'

const ChatRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const chatId = toChatId(useParams().chatId ?? '')
  const canPrompt = useHasLlmCredential(workspaceId)
  const blockedNotice = (
    <>
      Connect an LLM key in your profile to prompt.{' '}
      <Link to={`/w/${workspaceId}/profile`} className="underline">
        Open profile
      </Link>
    </>
  )
  return (
    <div className="flex h-full">
      <PromptAccessProvider canPrompt={canPrompt} blockedNotice={blockedNotice}>
        <ChatView headerActions={<PanelToggle />} />
      </PromptAccessProvider>
      <SidePanel workspaceId={workspaceId} chatId={chatId} />
    </div>
  )
}

export const App = ({ app }: { app: Application }) => (
  <StoreProvider store={app.store}>
    <SessionProvider session={app.session}>
      <WorkspaceProvider dependencies={app.workspaceDependencies}>
        <ConversationProvider dependencies={app.conversationDependencies}>
          <ProfileProvider dependencies={app.profileDependencies}>
            <BrowserRouter>
              <PanelProvider>
                <Routes>
                  <Route
                    path="/w/:workspaceId"
                    element={<WorkspaceLayout chatAdornment={(chatId) => <DraftIndicator chatId={chatId} />} />}
                  >
                    <Route index element={<p className="p-6 text-muted">Select a chat</p>} />
                    <Route path="chats/:chatId" element={<ChatRoute />} />
                    <Route
                      path="profile"
                      element={
                        <div className="p-6">
                          <ProfileView />
                        </div>
                      }
                    />
                  </Route>
                  <Route path="*" element={<Navigate to={`/w/${app.session.defaultWorkspaceId}`} replace />} />
                </Routes>
              </PanelProvider>
            </BrowserRouter>
          </ProfileProvider>
        </ConversationProvider>
      </WorkspaceProvider>
    </SessionProvider>
  </StoreProvider>
)
