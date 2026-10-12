import { ChatIndicators, ChatView, ConversationProvider } from '@hq/conversation'
import { StoreProvider } from '@hq/db/react'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { PanelProvider, PanelToggle, SidePanel } from '@hq/panel'
import { ProfileProvider, ProfileView, useHasLlmCredential } from '@hq/profile'
import { MyMachineSection, RuntimeHostsSection, RuntimeProvider, RuntimeStatus, UseToolButtons } from '@hq/runtime'
import { SessionProvider, useSession } from '@hq/session'
import { ChatUsageTable, UsageSection } from '@hq/usage'
import { useIsWorkspaceAdmin, WorkspaceLayout, WorkspaceProvider } from '@hq/workspace'
import { BrowserRouter, Link, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import type { Application } from './factory.ts'

const ChatRoute = ({ commands }: { commands: Application['conversationCommands'] }) => {
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
      <ChatView
        headerActions={<PanelToggle />}
        runtimeStatus={
          <RuntimeStatus
            workspaceId={workspaceId}
            chatId={chatId}
            onRetry={() => commands.retryAgent({ workspaceId, chatId })}
          />
        }
        canPrompt={canPrompt}
        blockedNotice={blockedNotice}
      />
      <SidePanel
        workspaceId={workspaceId}
        chatId={chatId}
        usageTab={<ChatUsageTable workspaceId={workspaceId} chatId={chatId} />}
      />
    </div>
  )
}

const SettingsRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const isAdmin = useIsWorkspaceAdmin(workspaceId)
  return (
    <div className="flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">Workspace settings</h1>
      {isAdmin ? (
        <>
          <RuntimeHostsSection workspaceId={workspaceId} />
          <UsageSection workspaceId={workspaceId} />
        </>
      ) : (
        <p className="text-muted">Only workspace admins can see this page</p>
      )}
    </div>
  )
}

const ProfileRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  return (
    <div className="p-6">
      <ProfileView llmAccessActions={<UseToolButtons workspaceId={workspaceId} memberId={memberId} />}>
        <MyMachineSection workspaceId={workspaceId} memberId={memberId} />
      </ProfileView>
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
                <PanelProvider>
                  <Routes>
                    <Route
                      path="/w/:workspaceId"
                      element={<WorkspaceLayout chatAdornment={(chatId) => <ChatIndicators chatId={chatId} />} />}
                    >
                      <Route index element={<p className="p-6 text-muted">Select a chat</p>} />
                      <Route path="chats/:chatId" element={<ChatRoute commands={app.conversationCommands} />} />
                      <Route path="settings" element={<SettingsRoute />} />
                      <Route path="profile" element={<ProfileRoute />} />
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
