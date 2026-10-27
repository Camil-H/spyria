import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, ErrorMessage, ghostButtonClass, MemberAvatar, useGuardedAction } from '@spyria/ui'
import { useRef } from 'react'
import { Avatar } from '../domain/avatar.ts'
import { avatarImageOf } from './avatar-image.ts'
import { useProfileCommands } from './providers.tsx'

const acceptedImages = 'image/png,image/jpeg,image/gif,image/webp'

export const ProfilePictureSection = ({
  workspaceId,
  name,
  avatar,
}: {
  workspaceId: WorkspaceId
  name: string
  avatar: string | null
}) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const upload = (file: File) =>
    run(async () => commands.changeAvatar({ workspaceId, avatar: Avatar(await avatarImageOf(file)) }))
  return (
    <section aria-label="Profile picture" className="flex flex-col gap-2">
      <h2 className="text-sm text-muted">Profile picture</h2>
      <div className="flex flex-wrap items-center gap-3">
        <MemberAvatar name={name} image={avatar} size={64} />
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptedImages}
          aria-label="Picture file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) upload(file)
          }}
        />
        <button
          type="button"
          className={buttonClass}
          disabled={isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          {avatar ? 'Change picture' : 'Upload picture'}
        </button>
        {avatar && (
          <button
            type="button"
            className={ghostButtonClass}
            disabled={isPending}
            onClick={() => run(() => commands.changeAvatar({ workspaceId, avatar: null }))}
          >
            Remove picture
          </button>
        )}
        <ErrorMessage message={errorMessage} />
      </div>
    </section>
  )
}
