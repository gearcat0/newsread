// The scraper's signing identity: one secp256k1 key, kept as hex in a 0600
// file. Every article it emits carries this key as author; the metadata inside
// is hearsay, the signature is the only verified fact. `ethSigner` mirrors
// cage's test helper and keyring (eth-eip191, recovery byte +27), and the
// address helpers are copied from cage's src/shell/address.ts so what we print
// matches what the shell shows.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import type { Signer } from './cage.js'

export class IdentityError extends Error {
  override name = 'IdentityError'
}

export function ethAddress(priv: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(secp256k1.getPublicKey(priv, true)).toBytes(false)
  const digest = keccak_256(uncompressed.subarray(1))
  return digest.subarray(digest.length - 20)
}

export function ethSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'eth-eip191',
    pubkey: ethAddress(priv),
    async sign(signingInput: Uint8Array): Promise<Uint8Array> {
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${signingInput.length}`)
      const buf = new Uint8Array(prefix.length + signingInput.length)
      buf.set(prefix, 0)
      buf.set(signingInput, prefix.length)
      const recd = secp256k1.sign(keccak_256(buf), priv, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65)
      out.set(recd.subarray(1, 65), 0)
      out[64] = recd[0]! + 27
      return out
    }
  }
}

/** EIP-55 mixed-case display form. Non-address input is returned unchanged. */
export function toChecksumAddress(hex: string): string {
  const clean = hex.trim().replace(/^0[xX]/, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(clean)) return hex
  const digest = keccak_256(new TextEncoder().encode(clean))
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const nibble = i % 2 === 0 ? digest[i >> 1]! >> 4 : digest[i >> 1]! & 0x0f
    const ch = clean[i]!
    out += nibble >= 8 ? ch.toUpperCase() : ch
  }
  return out
}

/** Elided checksummed address: `0xf39Fd6…2266`. */
export function shortAddress(hex: string, n = 6): string {
  const full = toChecksumAddress(hex)
  if (!full.startsWith('0x')) return full.length > 2 * n ? `${full.slice(0, n)}…${full.slice(-4)}` : full
  return `0x${full.slice(2, 2 + n)}…${full.slice(-4)}`
}

export interface Identity {
  /** bare lowercase hex, the format's own convention */
  addressHex: string
  /** EIP-55 display form */
  address: string
  short: string
  signer: Signer
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function identityFromKey(priv: Uint8Array): Identity {
  const addressHex = toHex(ethAddress(priv))
  return { addressHex, address: toChecksumAddress(addressHex), short: shortAddress(addressHex), signer: ethSigner(priv) }
}

/** Read the key file, or generate one (dir 0700, file 0600). Refuses a key file
 *  that anyone but the owner can read. */
export function loadOrCreateIdentity(file: string): { identity: Identity; created: boolean } {
  if (existsSync(file)) {
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
      throw new IdentityError(`${file} is readable by others; run: chmod 600 ${JSON.stringify(file)}`)
    }
    const hex = readFileSync(file, 'utf8').trim().toLowerCase().replace(/^0x/, '')
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new IdentityError(`${file} does not contain a 32-byte hex key`)
    return { identity: identityFromKey(fromHex(hex)), created: false }
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const priv = secp256k1.utils.randomSecretKey()
  writeFileSync(file, toHex(priv) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return { identity: identityFromKey(priv), created: true }
}
