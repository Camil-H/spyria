import { useQuery } from '@hq/db'
import { useSession } from '../../app/session.tsx'
import { getProfile } from '../queries/get-profile.ts'

export const ProfileView = () => {
  const profile = useQuery(getProfile(useSession().memberId))
  return (
    <>
      <h1>Profile</h1>
      <p>{profile?.name}</p>
    </>
  )
}
