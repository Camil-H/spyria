import { Bot } from 'lucide-react'

const circleClass = 'flex shrink-0 items-center justify-center overflow-hidden rounded-full'

export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0]?.toLocaleUpperCase() ?? '')
    .join('')

export const MemberAvatar = ({ name, image, size = 20 }: { name: string; image: string | null; size?: number }) =>
  image ? (
    <img src={image} alt="" width={size} height={size} className={`${circleClass} object-cover`} />
  ) : (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      className={`${circleClass} bg-selected font-semibold text-muted`}
    >
      {initialsOf(name)}
    </span>
  )

export const AgentAvatar = ({ size = 20 }: { size?: number }) => (
  <span aria-hidden style={{ width: size, height: size }} className={`${circleClass} bg-accent text-accent-ink`}>
    <Bot size={Math.round(size * 0.65)} />
  </span>
)
