import { useQuery } from '@hq/db'
import { useSession } from '../../app/session.tsx'
import { getProfile } from '../queries/get-profile.ts'

export const ProfileView = () => {
  const profile = useQuery(getProfile(useSession().memberId))
  return (
    <>
      <h1 className="text-2xl font-semibold">Profile</h1>
      <p className="mt-2 text-muted">{profile?.name}</p>
    </>
  )
}
