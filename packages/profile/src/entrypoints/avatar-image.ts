import { avatarPixels, maximumAvatarLength } from '../domain/avatar.ts'
import { InvalidAvatar } from '../domain/errors.ts'

const jpegQualities = [0.85, 0.7, 0.5]

export const avatarImageOf = async (file: File) => {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new InvalidAvatar()
  })
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = avatarPixels
  canvas.height = avatarPixels
  const context = canvas.getContext('2d')
  if (!context) throw new InvalidAvatar()
  context.fillStyle = 'white'
  context.fillRect(0, 0, avatarPixels, avatarPixels)
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    avatarPixels,
    avatarPixels,
  )
  bitmap.close()
  const image = jpegQualities
    .map((quality) => canvas.toDataURL('image/jpeg', quality))
    .find((dataUrl) => dataUrl.length <= maximumAvatarLength)
  if (!image) throw new InvalidAvatar()
  return image
}
