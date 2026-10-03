import { ChatView, ConversationProvider, DraftIndicator, PromptAccessProvider, UnreadIndicator } from '@hq/conversation'
import { StoreProvider } from '@hq/db/react'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { PanelProvider, PanelToggle, SidePanel } from '@hq/panel'
import { ProfileProvider, ProfileView, useHasLlmCredential } from '@hq/profile'
import { SessionProvider } from '@hq/session'
import { WorkspaceLayout, WorkspaceProvider } from '@hq/workspace'
import { BrowserRouter, Link, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import type { Application } from './factory.ts'

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
                    element={
                      <WorkspaceLayout
                        chatAdornment={(chatId) => (
                          <>
                            <UnreadIndicator chatId={chatId} />
                            <DraftIndicator chatId={chatId} />
                          </>
                        )}
                      />
                    }
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
