import { ChatIndicators, ChatView, ConversationProvider, Markdown } from '@hq/conversation'
import { StoreProvider } from '@hq/db/react'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { PanelProvider, PanelToggle, SidePanel } from '@hq/panel'
import { ProfileProvider, useHasLlmCredential } from '@hq/profile'
import { RuntimeProvider, RuntimeStatus } from '@hq/runtime'
import { SessionProvider } from '@hq/session'
import { TransferChatForm, WorkspaceLayout, WorkspaceProvider } from '@hq/workspace'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import type { Application } from './factory.ts'

const SettingsRoute = lazy(() => import('./SettingsRoute.tsx'))
const ProfileRoute = lazy(() => import('./ProfileRoute.tsx'))
const ChatUsageTable = lazy(() => import('@hq/usage').then(({ ChatUsageTable }) => ({ default: ChatUsageTable })))

const ChatRoute = ({ commands }: { commands: Application['conversationCommands'] }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const chatId = toChatId(useParams().chatId ?? '')
  const hasLlmKey = useHasLlmCredential(workspaceId)
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
      <ChatView
        headerActions={<PanelToggle />}
        runtimeStatus={(canRetry) => (
          <RuntimeStatus
            workspaceId={workspaceId}
            chatId={chatId}
            onRetry={canRetry ? () => commands.retryAgent({ workspaceId, chatId }) : undefined}
          />
        )}
        hasLlmKey={hasLlmKey}
        blockedNotice={blockedNotice}
        frozenActions={<TransferChatForm workspaceId={workspaceId} chatId={chatId} />}
      />
      <SidePanel
        workspaceId={workspaceId}
        chatId={chatId}
        Markdown={Markdown}
        usageTab={<ChatUsageTable workspaceId={workspaceId} chatId={chatId} />}
      />
    </div>
  )
}

export const App = ({ app }: { app: Application }) => (
  <StoreProvider store={app.store}>
    <SessionProvider session={app.session}>
      <WorkspaceProvider commands={app.workspaceCommands}>
        <ConversationProvider commands={app.conversationCommands} agentStream={app.agentStream}>
          <ProfileProvider commands={app.profileCommands}>
            <RuntimeProvider commands={app.runtimeCommands}>
              <BrowserRouter>
                <PanelProvider commands={app.panelCommands}>
                  <Routes>
                    <Route
                      path="/w/:workspaceId"
                      element={<WorkspaceLayout chatAdornment={(chatId) => <ChatIndicators chatId={chatId} />} />}
                    >
                      <Route index element={<p className="p-6 text-muted">Select a chat</p>} />
                      <Route path="chats/:chatId" element={<ChatRoute commands={app.conversationCommands} />} />
                      <Route
                        path="settings/:card?"
                        element={
                          <Suspense>
                            <SettingsRoute />
                          </Suspense>
                        }
                      />
                      <Route
                        path="profile"
                        element={
                          <Suspense>
                            <ProfileRoute />
                          </Suspense>
                        }
                      />
                    </Route>
                    <Route path="*" element={<Navigate to={`/w/${app.session.defaultWorkspaceId}`} replace />} />
                  </Routes>
                </PanelProvider>
              </BrowserRouter>
            </RuntimeProvider>
          </ProfileProvider>
        </ConversationProvider>
      </WorkspaceProvider>
    </SessionProvider>
  </StoreProvider>
)
