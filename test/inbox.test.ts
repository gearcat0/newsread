import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { defineConfig } from '../src/config.js'
import { identityFromKey, type Identity } from '../src/identity.js'
import { handleInboxEvent } from '../src/inbox.js'
import { applyRequest, parseRequest, parseRequestLine, wantedSites } from '../src/subscribe.js'
import {
  admitBundle, buildBundle, buildSealedBundle, buildSealedEvent, cborToJs, jsToCbor, loadMemoProgram, NOSTR_ENC_SCHEME, parseBundle, toHex
} from '../src/souspli.js'
import { StateStore } from '../src/state.js'

const config = defineConfig({
  relays: ['wss://news.example'],
  about: { name: 'Example News' },
  sites: [
    { id: 'guardian', hosts: ['theguardian.com'], feeds: [] },
    { id: 'bbc', hosts: ['bbc.co.uk'], feeds: [] },
    { id: 'ap', hosts: ['apnews.com'], feeds: [] }
  ]
})
const KNOWN = ['guardian', 'bbc', 'ap']
const NOW = new Date('2026-11-11T12:00:00Z')
const nowS = Math.floor(NOW.getTime() / 1000)

describe('request grammar', () => {
  it('parses subscribe / unsubscribe / list, case and commas aside', () => {
    expect(parseRequestLine('Subscribe guardian, BBC')).toEqual({ action: 'subscribe', sites: ['guardian', 'bbc'] })
    expect(parseRequestLine('subscribe')).toEqual({ action: 'subscribe', sites: 'all' })
    expect(parseRequestLine('unsubscribe all')).toEqual({ action: 'unsubscribe', sites: 'all' })
    expect(parseRequestLine('list')).toEqual({ action: 'list' })
    expect(parseRequestLine('list me')).toBeNull()
    expect(parseRequestLine('hello there')).toBeNull()
  })
  it('reads the subject, then the first message line; strips Re:', () => {
    expect(parseRequest('Re: subscribe ap', '')).toEqual({ action: 'subscribe', sites: ['ap'] })
    expect(parseRequest('Hi', '\n\n  unsubscribe bbc\nthanks')).toEqual({ action: 'unsubscribe', sites: ['bbc'] })
    expect(parseRequest('Hi', 'just saying hello')).toBeNull()
  })
})

describe('applyRequest', () => {
  const meta = { ek: 'e', created: 10, envelopeHash: 'h' }
  it('subscribing adds, unknown ids are reported, all absorbs', () => {
    const a = applyRequest(undefined, { action: 'subscribe', sites: ['bbc', 'nope'] }, KNOWN, meta)
    expect(a).toEqual({ next: { ek: 'e', updated: 10, lastRequest: 'h', sites: ['bbc'] }, unknown: ['nope'] })
    const b = applyRequest(a.next, { action: 'subscribe', sites: ['ap'] }, KNOWN, { ...meta, created: 11 })
    expect(b.next?.sites).toEqual(['ap', 'bbc'])
    expect(applyRequest(b.next, { action: 'subscribe', sites: 'all' }, KNOWN, meta).next?.sites).toBe('all')
    expect(applyRequest(undefined, { action: 'subscribe', sites: ['nope'] }, KNOWN, meta).next).toBeUndefined()
  })
  it('unsubscribing from part of "all" leaves the rest; from everything removes the record', () => {
    const all = { ek: 'e', updated: 1, lastRequest: 'x', sites: 'all' as const }
    expect(applyRequest(all, { action: 'unsubscribe', sites: ['bbc'] }, KNOWN, meta).next?.sites).toEqual(['ap', 'guardian'])
    expect(applyRequest(all, { action: 'unsubscribe', sites: 'all' }, KNOWN, meta).next).toBeUndefined()
    const one = { ...all, sites: ['bbc'] }
    expect(applyRequest(one, { action: 'unsubscribe', sites: ['bbc'] }, KNOWN, meta).next).toBeUndefined()
  })
  it('wantedSites is the union over subscribers', () => {
    expect([...wantedSites({ a: { ek: '', updated: 0, lastRequest: '', sites: ['bbc'] }, b: { ek: '', updated: 0, lastRequest: '', sites: ['ap', 'gone'] } }, KNOWN)].sort()).toEqual(['ap', 'bbc'])
    expect(wantedSites({ a: { ek: '', updated: 0, lastRequest: '', sites: 'all' } }, KNOWN).size).toBe(3)
  })
})

function memoTo(from: Identity, bot: Identity, subject: string, created: number, opts: { message?: string; bind?: boolean } = {}): Promise<Uint8Array> {
  return buildSealedBundle(from.signer, [bot.nostr.pub, from.nostr.pub], {
    program: loadMemoProgram(),
    type: 'memo',
    args: jsToCbor({ to: 'Example News', from: 'Ada', subject, message: opts.message ?? '', enclosures: [] }),
    created,
    ...(opts.bind === false ? {} : { enc: { e: NOSTR_ENC_SCHEME, ek: from.nostr.pub } })
  })
}

describe('handleInboxEvent', () => {
  const bot = identityFromKey(secp256k1.utils.randomSecretKey())
  const ada = identityFromKey(secp256k1.utils.randomSecretKey())
  const ctx = (state = new StateStore()) => ({ config, identity: bot, state, now: () => NOW })

  it('subscribes from a sealed memo and answers with a memo only the subscriber (and the bot) can open', async () => {
    const c = ctx()
    const ev = await buildSealedEvent(await memoTo(ada, bot, 'subscribe guardian', nowS - 60), nowS)
    const out = await handleInboxEvent(ev, c)
    expect(out.kind).toBe('handled')
    expect(c.state.data.subscribers[ada.addressHex]).toEqual({ ek: ada.nostr.pubHex, sites: ['guardian'], updated: nowS - 60, lastRequest: expect.any(String) })
    if (out.kind !== 'handled' || !out.reply) throw new Error('no reply')

    const replyTar = Uint8Array.from(Buffer.from(out.reply.content, 'base64'))
    const opened = admitBundle(parseBundle(replyTar), { unsealer: ada.unsealer })
    expect(opened.status).toBe('valid')
    if (opened.status !== 'valid') return
    expect(toHex(opened.envelope.author.k)).toBe(bot.addressHex)
    expect(toHex(opened.envelope.author.ek!)).toBe(bot.nostr.pubHex)
    const args = cborToJs(opened.manifest.args) as { to: string; from: string; message: string }
    expect(args.to).toBe('Ada')
    expect(args.from).toBe('Example News')
    expect(args.message).toMatch(/subscribed to guardian/)
    const stranger = identityFromKey(secp256k1.utils.randomSecretKey())
    expect(admitBundle(parseBundle(replyTar), { unsealer: stranger.unsealer }).status).toBe('not-for-me')
    // the event says nothing about who is talking to whom
    expect(out.reply.pubkey).not.toBe(bot.nostr.pubHex)
    expect(out.reply.tags.map((t) => t[0])).toEqual(['t', 'x', 'thing-type'])
  })

  it('an older letter never undoes a newer one; the same letter twice is seen', async () => {
    const c = ctx()
    const newer = await buildSealedEvent(await memoTo(ada, bot, 'subscribe all', nowS - 10), nowS)
    const older = await buildSealedEvent(await memoTo(ada, bot, 'unsubscribe all', nowS - 100), nowS)
    expect((await handleInboxEvent(newer, c)).kind).toBe('handled')
    expect((await handleInboxEvent(older, c)).kind).toBe('stale')
    expect(c.state.data.subscribers[ada.addressHex]?.sites).toBe('all')
    expect((await handleInboxEvent(newer, c)).kind).toBe('seen')
  })

  it('unknown sites are named in the reply; list answers without changing anything', async () => {
    const c = ctx()
    const out = await handleInboxEvent(await buildSealedEvent(await memoTo(ada, bot, 'subscribe bbc reuters', nowS - 5), nowS), c)
    if (out.kind !== 'handled' || !out.reply) throw new Error('no reply')
    const opened = admitBundle(parseBundle(Uint8Array.from(Buffer.from(out.reply.content, 'base64'))), { unsealer: ada.unsealer })
    if (opened.status !== 'valid') throw new Error(opened.status)
    expect((cborToJs(opened.manifest.args) as { message: string }).message).toMatch(/Not a site here: reuters/)
    const before = JSON.stringify(c.state.data.subscribers)
    expect((await handleInboxEvent(await buildSealedEvent(await memoTo(ada, bot, 'list', nowS - 1), nowS), c)).kind).toBe('handled')
    expect(JSON.stringify(c.state.data.subscribers)).toBe(before)
  })

  it('drops what is not for us, not sealed, not a request, or tampered', async () => {
    const c = ctx()
    const other = identityFromKey(secp256k1.utils.randomSecretKey())
    expect((await handleInboxEvent(await buildSealedEvent(await memoTo(ada, other, 'subscribe all', nowS), nowS), c)).kind).toBe('not-for-me')
    expect((await handleInboxEvent(await buildSealedEvent(await memoTo(ada, bot, 'hello', nowS), nowS), c)).kind).toBe('not-a-request')
    const ev = await buildSealedEvent(await memoTo(ada, bot, 'subscribe all', nowS), nowS)
    const tampered = { ...ev, tags: ev.tags.map((t) => (t[0] === 'x' ? ['x', '00'.repeat(32)] : t)) }
    const out = await handleInboxEvent(tampered, c)
    expect(out.kind).toBe('ignored') // the id no longer matches, so the event itself is rejected
    expect(Object.keys(c.state.data.subscribers)).toHaveLength(0)
    expect((await handleInboxEvent({ kind: 1, content: 'hi' }, c)).kind).toBe('ignored')
  })

  it('a public (unsealed) memo is not a request', async () => {
    const c = ctx()
    const pub = await buildBundle(ada.signer, { program: loadMemoProgram(), type: 'memo', args: jsToCbor({ subject: 'subscribe all' }) })
    const ev = await buildSealedEvent(pub, nowS) // dressed up as sealed, but the bytes are not
    const out = await handleInboxEvent(ev, c)
    // A public bundle admits without the unsealer; it must not count, or
    // anyone holding a public memo of Ada's could replay it as her request.
    expect(out).toEqual({ kind: 'ignored', reason: 'not sealed' })
  })

  it('without a bound key the change stands but there is no reply', async () => {
    const c = ctx()
    const out = await handleInboxEvent(await buildSealedEvent(await memoTo(ada, bot, 'subscribe ap', nowS, { bind: false }), nowS), c)
    expect(out).toMatchObject({ kind: 'handled', reply: null })
    expect(c.state.data.subscribers[ada.addressHex]?.sites).toEqual(['ap'])
  })

  it('state survives a save/load round trip, and a v1 file migrates', () => {
    const dir = mkdtempSync(join(process.env['NEWSREAD_TEST_TMP'] ?? tmpdir(), 'newsread-state-'))
    const file = join(dir, 's.json')
    writeFileSync(file, JSON.stringify({ version: 1, stories: { 'https://x/1': { siteId: 'a' } }, aliases: {}, feeds: {} }))
    const s = StateStore.load(file)
    expect(s.data.version).toBe(2)
    expect(s.data.subscribers).toEqual({})
    expect(s.data.inboxSeen).toEqual([])
    expect(Object.keys(s.data.stories)).toEqual(['https://x/1'])
    s.data.subscribers['ab'] = { ek: 'e', sites: 'all', updated: 1, lastRequest: 'h' }
    s.markSeen('h1')
    s.save()
    const t = StateStore.load(file)
    expect(t.data.subscribers['ab']?.sites).toBe('all')
    expect(t.hasSeen('h1')).toBe(true)
    writeFileSync(file, JSON.stringify({ version: 9 }))
    expect(() => StateStore.load(file)).toThrow(/unsupported state version/)
  })
})
