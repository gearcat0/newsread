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
  /** Where these came from, for error messages. */
  file?: string
  seedboxes: Record<string, BoxSecret>
  webseed?: { accessKeyId: string; secretAccessKey: string }
}

export class SecretsError extends Error {
  override name = 'SecretsError'
}

/** ' at line L column C' from a JSON.parse error, or '' — and nothing else from it. */
export function jsonErrorPlace(e: unknown): string {
  const m = /\(line (\d+) column (\d+)\)/.exec(e instanceof Error ? e.message : '')
  return m ? ` at line ${m[1]} column ${m[2]}` : ''
}

export function loadSecrets(file: string): Secrets {
  if (!existsSync(file)) return { file, seedboxes: {} }
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new SecretsError(`${file} is readable by others; run: chmod 600 ${JSON.stringify(file)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    // Never pass the parser's message on: V8 sometimes quotes the input in it
    // ('Unexpected token …, "{"password": …" is not valid JSON'), and this
    // input is passwords. Say where, not what.
    throw new SecretsError(`${file}: not valid JSON${jsonErrorPlace(e)} (the file's contents are not shown, since they are secrets)`)
  }
  const o = (raw ?? {}) as Partial<Secrets>
  if (typeof o !== 'object') throw new SecretsError(`${file}: not a JSON object`)
  const seedboxes: Record<string, BoxSecret> = {}
  for (const [name, v] of Object.entries(o.seedboxes ?? {})) {
    const b = (v ?? {}) as BoxSecret
    // Almost always a slip when typing the file, and it fails as a refused login.
    if (typeof b.username === 'string' && b.username !== b.username.trim()) {
      throw new SecretsError(`${file}: seedboxes.${name}.username starts or ends with whitespace`)
    }
    seedboxes[name] = {
      ...(typeof b.username === 'string' ? { username: b.username } : {}),
      ...(typeof b.password === 'string' ? { password: b.password } : {})
    }
  }
  const w = o.webseed
  if (w && (typeof w.accessKeyId !== 'string' || typeof w.secretAccessKey !== 'string')) {
    throw new SecretsError(`${file}: webseed needs accessKeyId and secretAccessKey strings`)
  }
  return { file, seedboxes, ...(w ? { webseed: { accessKeyId: w.accessKeyId, secretAccessKey: w.secretAccessKey } } : {}) }
}
