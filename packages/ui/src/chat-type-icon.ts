import { Bot, Hash } from 'lucide-react'

export const chatTypeIconOf = (type: 'channel' | 'runtime') =>
  type === 'channel' ? { Icon: Hash, label: 'Channel' } : { Icon: Bot, label: 'Runtime chat' }
