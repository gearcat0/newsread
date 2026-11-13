// The ONLY module that reaches into vendor/souspli. Everything else imports the
// thing-format API and the article program from here, so a submodule bump or a
// future move to a published package is a one-file change.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export {
  buildBundle,
  buildSealedBundle,
  parseBundle,
  admitBundle,
  conversationKey,
  nip44Decrypt,
  isSealed,
  jsToCbor,
  cborToJs,
  encode,
  hash,
  toHex,
  fromHex,
  chainInfo,
  DEFAULT_LIMITS,
  DEFAULT_BUNDLE_LIMITS
} from '../vendor/souspli/src/format/index.js'
export type {
  Signer,
  CborValue,
  AdmissionResult,
  Hash,
  Manifest,
  Envelope,
  Unsealer
} from '../vendor/souspli/src/format/index.js'

// The shell's relay-event codec. It imports only @noble and src/format, so it
// runs outside the app; reusing it (rather than a copy) keeps our events and the
// shell's parser from drifting apart.
export {
  THING_KIND,
  NOSTR_ENC_SCHEME,
  MAX_INLINE_BUNDLE,
  TAG,
  SEALED_TYPE,
  eventId,
  buildThingEvent,
  buildSealedEvent,
  parseThingEvent
} from '../vendor/souspli/src/shell/nostr/event.js'
export type { NostrEvent, ParsedThingEvent } from '../vendor/souspli/src/shell/nostr/event.js'

import { hash as sha256, toHex as hex } from '../vendor/souspli/src/format/index.js'

/** The article renderer that ships with Souspli. Its bytes ARE the program of every
 *  article thing; the shell groups things by (type, sha256(program)), so this
 *  file must be shipped byte-for-byte. */
export const ARTICLE_PROGRAM_PATH = fileURLToPath(
  new URL('../vendor/souspli/samples/article.html', import.meta.url)
)

/** The memo renderer: the bot's about letter and its replies to subscribers. */
export const MEMO_PROGRAM_PATH = fileURLToPath(new URL('../vendor/souspli/samples/memo.html', import.meta.url))

let programCache: Uint8Array | undefined
let memoCache: Uint8Array | undefined

export function loadProgram(): Uint8Array {
  if (!programCache) programCache = new Uint8Array(readFileSync(ARTICLE_PROGRAM_PATH))
  return programCache
}

export function loadMemoProgram(): Uint8Array {
  if (!memoCache) memoCache = new Uint8Array(readFileSync(MEMO_PROGRAM_PATH))
  return memoCache
}

export function programHashHex(): string {
  return hex(sha256(loadProgram()))
}
