import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import type { WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, focusRing, MemberAvatar, menuContentClass, menuItemClass, useGuardedAction } from '@spyria/ui'
import { Pencil } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { Avatar } from '../domain/avatar.ts'
import { avatarImageOf } from './avatar-image.ts'
import { useProfileCommands } from './providers.tsx'

const acceptedImages = 'image/png,image/jpeg,image/gif,image/webp'
const pictureButtonClass = `group relative flex rounded-full disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`

const PictureWithEditHint = ({ name, avatar }: { name: string; avatar: string | null }) => (
  <>
    <MemberAvatar name={name} image={avatar} size={64} />
    <span
      aria-hidden
      className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100"
    >
      <Pencil className="size-5" />
    </span>
  </>
)

export const ProfilePictureSection = ({
  workspaceId,
  name,
  avatar,
  beside,
}: {
  workspaceId: WorkspaceId
  name: string
  avatar: string | null
  beside: ReactNode
}) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chooseFile = () => fileInputRef.current?.click()
  const upload = (file: File) =>
    run(async () => commands.changeAvatar({ workspaceId, avatar: Avatar(await avatarImageOf(file)) }))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4">
        <section aria-label="Profile picture" className="flex">
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
          {avatar ? (
            <Root>
              <Trigger aria-label="Edit profile picture" disabled={isPending} className={pictureButtonClass}>
                <PictureWithEditHint name={name} avatar={avatar} />
              </Trigger>
              <Content align="start" className={menuContentClass}>
                <Item className={menuItemClass} onSelect={chooseFile}>
                  Change picture
                </Item>
                <Item
                  className={menuItemClass}
                  onSelect={() => run(() => commands.changeAvatar({ workspaceId, avatar: null }))}
                >
                  Remove picture
                </Item>
              </Content>
            </Root>
          ) : (
            <button
              type="button"
              aria-label="Add profile picture"
              disabled={isPending}
              onClick={chooseFile}
              className={pictureButtonClass}
            >
              <PictureWithEditHint name={name} avatar={null} />
            </button>
          )}
        </section>
        {beside}
      </div>
      <ErrorMessage message={errorMessage} />
    </div>
  )
}
