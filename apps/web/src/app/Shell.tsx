import { StoreProvider } from '@hq/db'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { BrowserRouter, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import { ConversationProvider } from '../conversation/entrypoints/providers.tsx'
import { ChatView, DraftIndicator } from '../conversation/surface.ts'
import { PanelProvider, PanelToggle, SidePanel } from '../panel/surface.ts'
import { ProfileView } from '../profile/entrypoints/ProfileView.tsx'
import { WorkspaceProvider } from '../workspace/entrypoints/providers.tsx'
import { WorkspaceLayout } from '../workspace/entrypoints/WorkspaceLayout.tsx'
import type { Application } from './factory.ts'
import { SessionProvider } from './session.tsx'

const ChatRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const chatId = toChatId(useParams().chatId ?? '')
  return (
    <div className="flex h-full">
      <ChatView headerActions={<PanelToggle />} />
      <SidePanel workspaceId={workspaceId} chatId={chatId} />
    </div>
  )
}

export const App = ({ app }: { app: Application }) => (
  <StoreProvider store={app.store}>
    <SessionProvider session={app.session}>
      <WorkspaceProvider dependencies={app.workspaceDependencies}>
        <ConversationProvider dependencies={app.conversationDependencies}>
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
        </ConversationProvider>
      </WorkspaceProvider>
    </SessionProvider>
  </StoreProvider>
)
