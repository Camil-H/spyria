import {
  ChatIndicators,
  ChatView,
  ConversationProvider,
  Markdown,
  RuntimeMenu,
  SearchDialog,
} from '@spyria/conversation'
import { StoreProvider } from '@spyria/db/react'
import { chatId as toChatId, type WorkspaceId } from '@spyria/kernel'
import { OnboardingProvider, SidebarChecklistLink } from '@spyria/onboarding'
import { PanelProvider, PanelToggle, SidePanel } from '@spyria/panel'
import { ProfileProvider } from '@spyria/profile'
import { RuntimeProvider, RuntimeStatus } from '@spyria/runtime'
import { SessionProvider, useSession } from '@spyria/session'
import { KeyboardShortcuts } from '@spyria/ui'
import { BudgetNotice, UsageProvider } from '@spyria/usage'
import { TransferChatForm, WorkspaceLayout, WorkspaceProvider } from '@spyria/workspace'
import { lazy, Suspense, use } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import { sharedAuthMode } from './auth.ts'
import type { Application } from './factory.ts'

const SettingsRoute = lazy(() => import('./SettingsRoute.tsx'))
const ProfileRoute = lazy(() => import('./ProfileRoute.tsx'))
const ChatUsageTable = lazy(() => import('@spyria/usage').then(({ ChatUsageTable }) => ({ default: ChatUsageTable })))

const ChecklistLink = (props: { workspaceId: WorkspaceId; isCollapsed: boolean }) => (
  <SidebarChecklistLink {...props} usesSingleSignOn={use(sharedAuthMode()).authMode === 'sso'} />
)

const ChatRoute = ({ commands }: { commands: Application['conversationCommands'] }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const chatId = toChatId(useParams().chatId ?? '')
  const { memberId } = useSession()
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
        runtimeStatus={({ canRetry, canManage, isAgentWorking }) => (
          <RuntimeStatus
            workspaceId={workspaceId}
            chatId={chatId}
            onRetry={canRetry ? () => commands.retryAgent({ workspaceId, chatId }) : undefined}
            menu={
              canManage
                ? (status) => (
                    <RuntimeMenu workspaceId={workspaceId} chatId={chatId} isAgentWorking={isAgentWorking}>
                      {status}
                    </RuntimeMenu>
                  )
                : undefined
            }
          />
        )}
        blockedNotice={blockedNotice}
        budgetNotice={<BudgetNotice workspaceId={workspaceId} memberId={memberId} />}
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
              <UsageProvider commands={app.usageCommands}>
                <OnboardingProvider commands={app.onboardingCommands}>
                  <BrowserRouter>
                    <PanelProvider commands={app.panelCommands}>
                      <Routes>
                        <Route
                          path="/w/:workspaceId"
                          element={
                            <WorkspaceLayout
                              chatAdornment={(chatId) => <ChatIndicators chatId={chatId} />}
                              sidebarTopItem={(props) => (
                                <Suspense>
                                  <ChecklistLink {...props} />
                                </Suspense>
                              )}
                              searchDialog={(props) => (
                                <Suspense>
                                  <SearchDialog {...props} />
                                </Suspense>
                              )}
                            />
                          }
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
                      <KeyboardShortcuts />
                    </PanelProvider>
                  </BrowserRouter>
                </OnboardingProvider>
              </UsageProvider>
            </RuntimeProvider>
          </ProfileProvider>
        </ConversationProvider>
      </WorkspaceProvider>
    </SessionProvider>
  </StoreProvider>
)
