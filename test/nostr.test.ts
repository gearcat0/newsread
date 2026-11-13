import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { deriveNostrKey, identityFromKey } from '../src/identity.js'
import { pointerEvent, inlineEvent, FEED_TAG } from '../src/nostr/announce.js'
import { RelayClient } from '../src/nostr/relay.js'
import { admitBundle, buildSealedBundle, parseBundle, parseThingEvent, toHex, MAX_INLINE_BUNDLE } from '../src/souspli.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { fakeRelay } from './helpers/fakeRelay.js'

const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))

// Ada, from the Souspli world fixture: the private key comes from that repo's
// hard-coded DEV mnemonic (tools/world/roster.ts — public, worthless), and the
// nostr key is the one the shell's keyring wrote to identity.pub.json for her.
const ADA_PRIV = '33fa40f84e854b941c2b0436dd4a256e1df1cb41b9c1c0ccc8446408c19b8bf9'
const ADA_ADDRESS = '58a57ed9d8d624cbd12e2c467d34787555bb1b25'
const ADA_NOSTR = '2946f3a8ad41d67599df07e45477967038afc60f755e360b5988202b88a57f4e'

describe('nostr identity', () => {
  it('derives the same nostr key the Souspli shell does', () => {
    const id = identityFromKey(fromHex(ADA_PRIV))
    expect(id.addressHex).toBe(ADA_ADDRESS)
    expect(id.nostr.pubHex).toBe(ADA_NOSTR)
    expect(toHex(schnorr.getPublicKey(deriveNostrKey(fromHex(ADA_PRIV))))).toBe(ADA_NOSTR)
  })

  it('opens a letter sealed to its nostr key, and refuses one that is not', async () => {
    const me = identityFromKey(secp256k1.utils.randomSecretKey())
    const other = identityFromKey(secp256k1.utils.randomSecretKey())
    const tar = await buildSealedBundle(other.signer, [me.nostr.pub], { program: new TextEncoder().encode('<p>hi</p>'), type: 'page' })
    const r = admitBundle(parseBundle(tar), { unsealer: me.unsealer })
    expect(r.status).toBe('valid')
    if (r.status === 'valid') expect(toHex(r.envelope.author.k)).toBe(other.addressHex)
    expect(admitBundle(parseBundle(tar), { unsealer: other.unsealer }).status).toBe('not-for-me')
  })
})

describe('announce events', () => {
  const id = identityFromKey(secp256k1.utils.randomSecretKey())

  it('a pointer the shell parses: signed by our key, x, type, feed and magnet', async () => {
    const ev = await pointerEvent(id.nostr, { envelopeHash: 'ab'.repeat(32), type: 'article', feed: 'guardian', locator: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), createdAt: 1000 })
    const p = parseThingEvent(ev, MAX_INLINE_BUNDLE)
    expect('error' in p).toBe(false)
    if ('error' in p) return
    expect(p.event.pubkey).toBe(id.nostr.pubHex)
    expect(p.envelopeHash).toBe('ab'.repeat(32))
    expect(p.type).toBe('article')
    expect(p.fetchLocator).toMatch(/^magnet:/)
    expect(p.bundle).toBeNull()
    expect(ev.tags).toContainEqual([FEED_TAG, 'guardian'])
    expect(ev.tags.length).toBeLessThanOrEqual(16) // relay/src/nostr.ts tag cap
  })

  it('an inline event refuses anything over the cap', async () => {
    await expect(inlineEvent(id.nostr, new Uint8Array(MAX_INLINE_BUNDLE + 1), 'ab'.repeat(32), 'memo', 1)).rejects.toThrow(/inline cap/)
    const ok = await inlineEvent(id.nostr, new Uint8Array([1, 2, 3]), 'ab'.repeat(32), 'memo', 1)
    const p = parseThingEvent(ok, MAX_INLINE_BUNDLE)
    expect('error' in p ? p.error : Array.from(p.bundle ?? [])).toEqual([1, 2, 3])
  })
})

describe('RelayClient', () => {
  const id = identityFromKey(secp256k1.utils.randomSecretKey())
  const ev = (n: number) => pointerEvent(id.nostr, { envelopeHash: n.toString(16).padStart(64, '0'), type: 'article', feed: 'x', locator: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), createdAt: n })

  it('publishes, treats a duplicate as success, reports a refusal', async () => {
    const relay = fakeRelay()
    const c = new RelayClient('wss://fake', { socket: relay.factory })
    const e1 = await ev(1)
    expect(await c.publish(e1)).toEqual({ ok: true, message: '' })
    expect((await c.publish(e1)).ok).toBe(true)
    relay.refuse = () => 'rate-limited: slow down'
    expect(await c.publish(await ev(2))).toEqual({ ok: false, message: 'rate-limited: slow down' })
    expect(relay.events).toHaveLength(1)
    c.close()
  })

  it('reads stored events to EOSE, filtered by since and #t', async () => {
    const relay = fakeRelay()
    for (const n of [5, 10, 15]) relay.inject(await ev(n))
    const c = new RelayClient('wss://fake', { socket: relay.factory })
    const got: number[] = []
    const res = await c.fetchStored([{ kinds: [3400], '#t': ['thing'], since: 10 }], (e) => got.push((e as { created_at: number }).created_at))
    expect(res).toBe('eose')
    expect(got).toEqual([10, 15])
    c.close()
  })

  it('keeps a live subscription and gets later events', async () => {
    const relay = fakeRelay()
    const c = new RelayClient('wss://fake', { socket: relay.factory })
    const got: number[] = []
    c.subscribe('live', () => [{ kinds: [3400] }], (e) => got.push((e as { created_at: number }).created_at))
    await new Promise((r) => setTimeout(r, 5))
    relay.inject(await ev(42))
    await new Promise((r) => setTimeout(r, 5))
    expect(got).toEqual([42])
    c.close()
  })

  it('a dead relay fails a publish instead of hanging', async () => {
    const c = new RelayClient('wss://dead', {
      socket: () => {
        throw new Error('ECONNREFUSED')
      }
    })
    expect(await c.publish(await ev(1))).toEqual({ ok: false, message: 'ECONNREFUSED' })
    c.close()
  })
})
