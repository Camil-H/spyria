import { StoreProvider } from '@hq/db'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { ChatView } from '../conversation/entrypoints/ChatView.tsx'
import { ConversationProvider } from '../conversation/entrypoints/providers.tsx'
import { DraftIndicator } from '../conversation/surface.ts'
import { ProfileView } from '../profile/entrypoints/ProfileView.tsx'
import { WorkspaceProvider } from '../workspace/entrypoints/providers.tsx'
import { WorkspaceLayout } from '../workspace/entrypoints/WorkspaceLayout.tsx'
import type { Application } from './factory.ts'
import { SessionProvider } from './session.tsx'

export const App = ({ app }: { app: Application }) => (
  <StoreProvider store={app.store}>
    <SessionProvider session={app.session}>
      <WorkspaceProvider dependencies={app.workspaceDependencies}>
        <ConversationProvider dependencies={app.conversationDependencies}>
          <BrowserRouter>
            <Routes>
              <Route
                path="/w/:workspaceId"
                element={<WorkspaceLayout chatAdornment={(chatId) => <DraftIndicator chatId={chatId} />} />}
              >
                <Route index element={<p className="p-6 text-muted">Select a chat</p>} />
                <Route path="chats/:chatId" element={<ChatView />} />
                <Route path="profile" element={<ProfileView />} />
              </Route>
              <Route path="*" element={<Navigate to={`/w/${app.session.defaultWorkspaceId}`} replace />} />
            </Routes>
          </BrowserRouter>
        </ConversationProvider>
      </WorkspaceProvider>
    </SessionProvider>
  </StoreProvider>
)
