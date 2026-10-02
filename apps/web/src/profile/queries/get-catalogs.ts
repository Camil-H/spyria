import type { Snapshot } from '@hq/db'

export const getCatalogs = () => (snapshot: Snapshot) => snapshot.planLoginHarnesses
