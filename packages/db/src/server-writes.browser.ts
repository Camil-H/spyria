const skippedOnClient = async () => undefined

export const insertLlmCredential = skippedOnClient
export const gatewayKeyRefsOf = async () => []
export const gatewayKeyRefOf = skippedOnClient
export const virtualKeyIdOf = skippedOnClient
export const virtualKeyIdsIn = async () => []
export const memberModelsOf = skippedOnClient
export const setModelDirectory = skippedOnClient
export const listedModelsOf = () => []
export const setVirtualKeyId = skippedOnClient
export const lockMembership = skippedOnClient
export const lockActiveAdminIds = async () => []
export const deleteMemberSessions = skippedOnClient
export const deleteGitHubConnection = skippedOnClient
export const appendWorkspaceEvent = skippedOnClient
export const copyWorkspaceSignIn = skippedOnClient
export const awaitsDomainVerification = async () => false
export const enqueueJob = skippedOnClient
export const insertAttachment = skippedOnClient
export const storedAttachmentBytesOf = async () => ({ pendingOfMember: 0, inWorkspace: 0 })
export const deleteAbandonedAttachments = skippedOnClient
export const lockPendingAttachments = async () => []
export const linkAttachments = skippedOnClient
export const deleteMessageAttachments = skippedOnClient
export const keepDeletedMessageText = skippedOnClient
export const redactDeletedMessageEvents = skippedOnClient
export const sentAttachmentOf = skippedOnClient
export const setRuntimeHostSecretHash = skippedOnClient
export const lockRuntimeHost = skippedOnClient
export const findRuntimeHostBySecretHash = skippedOnClient
export const lockRuntimes = async () => []
export const lockRuntimeHostLoads = async () => []
export const serverOnlyRuntimeValueOf = skippedOnClient
export const setServerOnlyRuntimeValue = skippedOnClient
export const rememberAgentConversation = skippedOnClient
export const lockChatTurn = async () => null
export const setChatTurnPrompter = skippedOnClient
export const chatTurnOf = skippedOnClient
export const setChatTurnFailure = skippedOnClient
export const runtimeChatOfLlmTokenHash = skippedOnClient
export const pendingPrompts = async () => []
export const openTaskStepsOf = async () => []
export const activeAgentTurns = async () => []
export const setRuntimesHostOnline = skippedOnClient
export const isChatEventStored = async () => false
export const lastAgentEvent = skippedOnClient
export const lastSessionId = skippedOnClient
export const chatEventsOf = async () => []
export const finishedToolCallEventOf = skippedOnClient
export const lastAdapterModelsOf = skippedOnClient
export const isWorkspaceHostOnline = async () => false
export const chatRoutingOf = skippedOnClient
export const setChatAgentModel = skippedOnClient
export const insertRoutingDecision = skippedOnClient
export const insertDelegation = skippedOnClient
export const setDelegationFields = skippedOnClient
export const insertToolCall = skippedOnClient
export const runningDelegationOfTokenHash = skippedOnClient
export const stopRunningDelegations = async () => []
export const appendChatEvent = () => Promise.reject(new Error('Chat events are appended on the server only'))
export const isSessionStartPending = async () => false
export const scheduleWorkspaceDeletion = skippedOnClient
export const lockDuePurge = async () => false
export const isWorkspaceDeleted = async () => false
export const workspaceCleanupOf = async () => ({ isPending: false, failed: [] })
export const purgeWorkspaceChunk = async () => 0
export const workspacePurgeTargetsOf = async () => ({ memberIds: [], runtimeChatIds: [] })
export const purgeWorkspaceRows = skippedOnClient
