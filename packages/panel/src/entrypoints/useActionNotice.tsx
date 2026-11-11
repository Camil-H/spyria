import { Toast } from '@spyria/ui'
import { useState } from 'react'

export type ActionOutcome = { isRefused: boolean; text: string }
type Notice = ActionOutcome & { id: string }

const shownMilliseconds = 5000

export const useActionNotice = () => {
  const [notice, setNotice] = useState<Notice>()
  const toast = notice && (
    <Toast
      key={notice.id}
      tone={notice.isRefused ? 'error' : 'success'}
      dismissAfterMilliseconds={notice.isRefused ? undefined : shownMilliseconds}
      onDismiss={() => setNotice(undefined)}
    >
      {notice.text}
    </Toast>
  )
  return { toast, notify: (outcome: ActionOutcome) => setNotice({ ...outcome, id: crypto.randomUUID() }) }
}
