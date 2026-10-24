import { Toast } from '@spyria/ui'
import { useEffect, useState } from 'react'

export type ActionOutcome = { isRefused: boolean; text: string }
type Notice = ActionOutcome & { id: string }

const shownMilliseconds = 5000

export const useActionNotice = () => {
  const [notice, setNotice] = useState<Notice>()
  useEffect(() => {
    if (!notice || notice.isRefused) return
    const timer = setTimeout(() => setNotice(undefined), shownMilliseconds)
    return () => clearTimeout(timer)
  }, [notice])
  const toast = notice && (
    <Toast key={notice.id} isAlert={notice.isRefused} onDismiss={() => setNotice(undefined)}>
      {notice.text}
    </Toast>
  )
  return { toast, notify: (outcome: ActionOutcome) => setNotice({ ...outcome, id: crypto.randomUUID() }) }
}
