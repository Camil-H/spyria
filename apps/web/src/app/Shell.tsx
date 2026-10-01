import { StoreProvider } from '@hq/db'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { ProfileView } from '../profile/entrypoints/ProfileView.tsx'
import { ChatStub } from '../workspace/entrypoints/ChatStub.tsx'
import { WorkspaceProvider } from '../workspace/entrypoints/providers.tsx'
import { WorkspaceLayout } from '../workspace/entrypoints/WorkspaceLayout.tsx'
import type { Application } from './factory.ts'
import { SessionProvider } from './session.tsx'

export const App = ({ app }: { app: Application }) => (
  <StoreProvider store={app.store}>
    <SessionProvider session={app.session}>
      <WorkspaceProvider dependencies={app.workspaceDependencies}>
        <BrowserRouter>
          <Routes>
            <Route path="/w/:workspaceId" element={<WorkspaceLayout />}>
              <Route index element={<p>Select a chat</p>} />
              <Route path="chats/:chatId" element={<ChatStub />} />
              <Route path="profile" element={<ProfileView />} />
            </Route>
            <Route path="*" element={<Navigate to={`/w/${app.session.defaultWorkspaceId}`} replace />} />
          </Routes>
        </BrowserRouter>
      </WorkspaceProvider>
    </SessionProvider>
  </StoreProvider>
)
