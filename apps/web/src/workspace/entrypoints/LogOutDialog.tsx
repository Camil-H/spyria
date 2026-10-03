import { buttonClass, Dialog } from '@hq/ui'

export const LogOutDialog = ({
  workspaceName,
  onConfirm,
  onClose,
}: {
  workspaceName: string
  onConfirm: () => void
  onClose: () => void
}) => (
  <Dialog label={`Log out of ${workspaceName}`} onClose={onClose}>
    <p className="text-sm text-muted">
      You will need to sign in again to use this workspace. Nothing is removed and you stay a member.
    </p>
    <button
      type="button"
      className={buttonClass}
      onClick={() => {
        onConfirm()
        onClose()
      }}
    >
      Log out
    </button>
  </Dialog>
)
