const skippedOnClient = async () => undefined

export const insertLlmCredential = skippedOnClient
export const gatewayKeyRefsOf = async () => []
export const gatewayKeyRefOf = skippedOnClient
export const virtualKeyIdOf = skippedOnClient
export const setVirtualKeyId = skippedOnClient
export const lockMembership = skippedOnClient
export const enqueueJob = skippedOnClient
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
export const activeAgentTurns = async () => []
export const setRuntimesHostOnline = skippedOnClient
export const isChatEventStored = async () => false
export const lastAgentEvent = skippedOnClient
export const agentObservationOf = skippedOnClient
export const appendChatEvent = () => Promise.reject(new Error('Chat events are appended on the server only'))
