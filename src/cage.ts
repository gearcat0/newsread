// The ONLY module that reaches into vendor/cage. Everything else imports the
// thing-format API and the article program from here, so a submodule bump or a
// future move to a published package is a one-file change.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export {
  buildBundle,
  parseBundle,
  admitBundle,
  jsToCbor,
  cborToJs,
  encode,
  hash,
  toHex,
  fromHex,
  chainInfo,
  DEFAULT_LIMITS,
  DEFAULT_BUNDLE_LIMITS
} from '../vendor/cage/src/format/index.js'
export type {
  Signer,
  CborValue,
  AdmissionResult,
  Hash,
  Manifest,
  Envelope
} from '../vendor/cage/src/format/index.js'

import { hash as sha256, toHex as hex } from '../vendor/cage/src/format/index.js'

/** The article renderer that ships with cage. Its bytes ARE the program of every
 *  article thing; the shell groups things by (type, sha256(program)), so this
 *  file must be shipped byte-for-byte. */
export const ARTICLE_PROGRAM_PATH = fileURLToPath(
  new URL('../vendor/cage/samples/article.html', import.meta.url)
)

let programCache: Uint8Array | undefined

export function loadProgram(): Uint8Array {
  if (!programCache) programCache = new Uint8Array(readFileSync(ARTICLE_PROGRAM_PATH))
  return programCache
}

export function programHashHex(): string {
  return hex(sha256(loadProgram()))
}
