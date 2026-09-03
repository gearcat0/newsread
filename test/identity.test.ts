import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ethAddress, ethSigner, identityFromKey, loadOrCreateIdentity, shortAddress, toChecksumAddress, IdentityError } from '../src/identity.js'
import { toChecksumAddress as cageChecksum, shortAddress as cageShort } from '../vendor/cage/src/shell/address.js'
import { admitBundle, buildBundle, parseBundle, toHex } from '../src/cage.js'

const tmp = (): string => mkdtempSync(join(process.env['NEWSREAD_TEST_TMP'] ?? tmpdir(), 'newsread-id-'))

describe('identity', () => {
  it('address helpers match cage byte for byte', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const hex = toHex(ethAddress(priv))
    expect(toChecksumAddress(hex)).toBe(cageChecksum(hex))
    expect(shortAddress(hex)).toBe(cageShort(hex))
    expect(toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')).toBe('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359')
  })
  it('the signer is accepted by cage admission and identified as the author', async () => {
    const priv = secp256k1.utils.randomSecretKey()
    const id = identityFromKey(priv)
    const tar = await buildBundle(ethSigner(priv), { program: new TextEncoder().encode('<p>x</p>'), type: 'page' })
    const r = admitBundle(parseBundle(tar))
    expect(r.status).toBe('valid')
    if (r.status !== 'valid') return
    expect(r.envelope.author.s).toBe('eth-eip191')
    expect(toHex(r.envelope.author.k)).toBe(id.addressHex)
  })
  it('creates a 0600 key file, reloads the same identity, refuses a loose file', () => {
    const file = join(tmp(), 'sub', 'identity.key')
    const a = loadOrCreateIdentity(file)
    expect(a.created).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
    const b = loadOrCreateIdentity(file)
    expect(b.created).toBe(false)
    expect(b.identity.address).toBe(a.identity.address)
    expect(a.identity.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(a.identity.short).toMatch(/^0x[0-9a-fA-F]{6}…[0-9a-fA-F]{4}$/)
    chmodSync(file, 0o644)
    expect(() => loadOrCreateIdentity(file)).toThrow(IdentityError)
  })
})
