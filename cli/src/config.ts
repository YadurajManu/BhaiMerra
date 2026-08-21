import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Profile = {
  api: string
  accessToken?: string
  refreshToken?: string
  fleetId?: string
  fleetName?: string
}

const configPath = () =>
  process.env.FLEET_CONFIG ?? join(homedir(), '.config', 'fleet-os', 'config.json')

export async function loadProfile(): Promise<Profile> {
  const fromEnv: Partial<Profile> = {
    api: process.env.FLEET_API ?? '',
    accessToken: process.env.FLEET_TOKEN,
    fleetId: process.env.FLEET_ID,
  }
  try {
    const stored = JSON.parse(await readFile(configPath(), 'utf8')) as Profile
    // Environment wins, so CI can override a developer's saved login.
    return {
      ...stored,
      ...Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v)),
      // Older builds could save an empty api field. Keep it empty so the
      // caller can give a precise configuration error rather than constructing
      // an invalid relative URL such as /auth/login.
      api: fromEnv.api || stored.api || '',
    } as Profile
  } catch {
    // The public control plane is the useful default for a first-time install.
    // Self-hosters and CI can always override it with FLEET_API or --api.
    return { api: fromEnv.api || 'https://fleetapi.plastikworld.xyz', ...fromEnv } as Profile
  }
}

export async function saveProfile(profile: Profile): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Contains a bearer token; 0600 or it is readable by anything on the box.
  await writeFile(path, JSON.stringify(profile, null, 2), { mode: 0o600 })
}

export const configLocation = configPath
