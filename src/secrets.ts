// Credentials for the seed boxes and the webseed bucket, kept out of the config
// module (which is code, and often committed). One JSON file, 0600, refused if
// anyone else can read it — the same rule as the identity key.
//
//   {
//     "seedboxes": { "<name>": { "username": "...", "password": "..." } },
//     "webseed":   { "accessKeyId": "...", "secretAccessKey": "..." }
//   }
import { existsSync, readFileSync, statSync } from 'node:fs'

export interface BoxSecret {
  username?: string
  password?: string
}

export interface Secrets {
  seedboxes: Record<string, BoxSecret>
  webseed?: { accessKeyId: string; secretAccessKey: string }
}

export class SecretsError extends Error {
  override name = 'SecretsError'
}

export function loadSecrets(file: string): Secrets {
  if (!existsSync(file)) return { seedboxes: {} }
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new SecretsError(`${file} is readable by others; run: chmod 600 ${JSON.stringify(file)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new SecretsError(`${file}: ${(e as Error).message}`)
  }
  const o = (raw ?? {}) as Partial<Secrets>
  if (typeof o !== 'object') throw new SecretsError(`${file}: not a JSON object`)
  const seedboxes: Record<string, BoxSecret> = {}
  for (const [name, v] of Object.entries(o.seedboxes ?? {})) {
    const b = (v ?? {}) as BoxSecret
    seedboxes[name] = {
      ...(typeof b.username === 'string' ? { username: b.username } : {}),
      ...(typeof b.password === 'string' ? { password: b.password } : {})
    }
  }
  const w = o.webseed
  if (w && (typeof w.accessKeyId !== 'string' || typeof w.secretAccessKey !== 'string')) {
    throw new SecretsError(`${file}: webseed needs accessKeyId and secretAccessKey strings`)
  }
  return { seedboxes, ...(w ? { webseed: { accessKeyId: w.accessKeyId, secretAccessKey: w.secretAccessKey } } : {}) }
}
