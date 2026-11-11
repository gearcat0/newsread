import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { Bot } from '../src/bot.js'
import { buildArticle } from '../src/bundle.js'
import { defineConfig, type UserConfig } from '../src/config.js'
import { identityFromKey } from '../src/identity.js'
import type { Publisher } from '../src/publish/index.js'
import type { SeedBox } from '../src/publish/types.js'
import { DirWebSeed } from '../src/publish/webseed.js'
import { FEED_TAG } from '../src/nostr/announce.js'
import {
  admitBundle, buildSealedBundle, buildSealedEvent, jsToCbor, loadMemoProgram, MAX_INLINE_BUNDLE, NOSTR_ENC_SCHEME, parseBundle, parseThingEvent, toHex
} from '../src/souspli.js'
import { StateStore } from '../src/state.js'
import { fakeRelay } from './helpers/fakeRelay.js'
import type { ArticleArgs } from '../src/args.js'

const tmp = (): string => mkdtempSync(join(process.env['NEWSREAD_TEST_TMP'] ?? tmpdir(), 'newsread-bot-'))
const quiet = { info: () => undefined, warn: () => undefined, debug: () => undefined }
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

class FakeBox implements SeedBox {
  readonly kind = 'fake'
  progressNow = 0
  have = new Map<string, Uint8Array>()
  constructor(readonly name: string) {}
  async add(metainfo: Uint8Array, infohash: string): Promise<void> {
    this.have.set(infohash, metainfo)
  }
  async progress(infohash: string): Promise<number | null> {
    return this.have.has(infohash) ? this.progressNow : null
  }
  async remove(infohash: string): Promise<void> {
    this.have.delete(infohash)
  }
}

async function setup(over: Partial<UserConfig> = {}) {
  const dir = tmp()
  const config = defineConfig({
    outDir: join(dir, 'out'),
    stateFile: join(dir, 'state.json'),
    relays: ['wss://news.example'],
    about: { name: 'Example News' },
    publish: {
      trackers: ['udp://tracker.example:6969/announce'],
      webseed: { kind: 'dir', dir: join(dir, 'www'), baseUrl: 'https://seed.example/t' },
      seedboxes: [{ kind: 'qbittorrent', name: 'box1', url: 'http://box1' }],
      seedTimeoutMs: 60_000
    },
    sites: [
      { id: 'guardian', publisher: 'The Guardian', hosts: ['theguardian.com'], feeds: [] },
      { id: 'bbc', hosts: ['bbc.co.uk'], feeds: [], always: true }
    ],
    ...over
  })
  const identity = identityFromKey(secp256k1.utils.randomSecretKey())
  const state = StateStore.load(config.stateFile)
  const box = new FakeBox('box1')
  let webseedUp = true
  const webseed = new DirWebSeed({ dir: join(dir, 'www'), baseUrl: 'https://seed.example/t', fetch: async () => new Response(null, { status: webseedUp ? 200 : 404 }) })
  const publisher: Publisher = { webseed, boxes: [box], trackers: config.publish!.trackers, seedTimeoutMs: 60_000 }
  const relay = fakeRelay()
  let now = new Date('2026-11-11T12:00:00Z')
  const bot = new Bot({ config, identity, state, publisher, log: quiet, now: () => now, relay: { socket: relay.factory } })

  // One archived story, as the pipeline would leave it.
  const args: ArticleArgs = { title: 'Scaffolding goes up', blocks: [{ kind: 'paragraph', text: 'Works begin Monday.' }], sourceUrl: 'https://www.theguardian.com/x' }
  const built = await buildArticle(identity.signer, args, new Map(), { path: 'news/theguardian.com/abc', seq: 1 }, Math.floor(now.getTime() / 1000), 256 * 1024, identity.nostr.pub)
  mkdirSync(join(dir, 'out', 'guardian'), { recursive: true })
  const outFile = join(dir, 'out', 'guardian', 'story.thing')
  writeFileSync(outFile, built.tar)
  state.setStory('https://www.theguardian.com/x', {
    siteId: 'guardian', path: 'news/theguardian.com/abc', seq: 1, envelopeHash: built.envelopeHash, manifestHash: built.manifestHash,
    contentHash: 'c', firstSeen: now.toISOString(), lastFetched: now.toISOString(), lastEmitted: now.toISOString(), outFile, title: 'Scaffolding goes up'
  })
  return { dir, config, identity, state, box, relay, bot, built, outFile, setNow: (d: Date) => (now = d), setWebseed: (up: boolean) => (webseedUp = up) }
}

describe('Bot.publishPending', () => {
  it('stages, waits for a seed box, then announces a pointer the shell can follow', async () => {
    const t = await setup()
    expect(await t.bot.publishPending()).toBe(0)
    const rec = t.state.data.stories['https://www.theguardian.com/x']!.publish!
    expect(rec.name).toBe(`article-${t.built.envelopeHash.slice(0, 8)}.thing`)
    expect(existsSync(rec.torrentFile)).toBe(true)
    expect([...readFileSync(join(t.dir, 'www', rec.name))]).toEqual([...t.built.tar])
    expect(t.box.have.has(rec.infohash)).toBe(true)
    expect(t.relay.events).toHaveLength(0) // nobody has the whole file yet

    t.box.progressNow = 1
    expect(await t.bot.publishPending()).toBe(1)
    expect(t.relay.events).toHaveLength(1)
    const ev = t.relay.events[0]!
    const p = parseThingEvent(ev, MAX_INLINE_BUNDLE)
    if ('error' in p) throw new Error(p.error)
    expect(p.envelopeHash).toBe(t.built.envelopeHash)
    expect(p.event.pubkey).toBe(t.identity.nostr.pubHex)
    expect(p.fetchLocator).toBe(rec.magnet)
    expect(rec.magnet).toContain(`xt=urn:btih:${rec.infohash}`)
    expect(rec.magnet).toContain('ws=https%3A%2F%2Fseed.example%2Ft%2Farticle-')
    // without xs a reader who reaches no peer never gets the metadata (checked against webtorrent 3.0.21)
    expect(rec.magnet).toContain(`xs=${encodeURIComponent(`https://seed.example/t/${rec.name}.torrent`)}`)
    expect([...readFileSync(join(t.dir, 'www', `${rec.name}.torrent`))]).toEqual([...readFileSync(rec.torrentFile)])
    expect(ev.tags).toContainEqual([FEED_TAG, 'guardian'])

    // the article binds the key that posted the pointer
    const r = admitBundle(parseBundle(t.built.tar))
    if (r.status !== 'valid') throw new Error(r.status)
    expect(r.envelope.author.e).toBe(NOSTR_ENC_SCHEME)
    expect(toHex(r.envelope.author.ek!)).toBe(ev.pubkey)

    expect(await t.bot.publishPending()).toBe(0) // nothing left
    expect(t.relay.events).toHaveLength(1)
    t.bot.close()
  })

  it('announces on the webseed alone once no box finishes in time — but only if it answers', async () => {
    const t = await setup()
    await t.bot.publishPending()
    t.setNow(new Date('2026-11-11T12:05:00Z'))
    t.setWebseed(false)
    await t.bot.publishPending()
    expect(t.relay.events).toHaveLength(0)
    t.setWebseed(true)
    await t.bot.publishPending()
    expect(t.relay.events).toHaveLength(1)
    t.bot.close()
  })

  it('retries a relay that refused, and restarts publishing for a new version', async () => {
    const t = await setup()
    t.box.progressNow = 1
    t.relay.refuse = () => 'rate-limited: too many posts'
    await t.bot.publishPending()
    expect(t.relay.events).toHaveLength(0)
    expect(t.state.pendingPublish(t.config.relays)).toHaveLength(1)
    t.relay.refuse = undefined
    await t.bot.publishPending()
    expect(t.relay.events).toHaveLength(1)
    const story = t.state.data.stories['https://www.theguardian.com/x']!
    story.envelopeHash = 'ff'.repeat(32) // as if the pipeline emitted v2 (same file, for the test)
    expect(t.state.pendingPublish(t.config.relays)).toHaveLength(1)
    await t.bot.publishPending()
    expect(story.publish!.envelopeHash).toBe('ff'.repeat(32))
    t.bot.close()
  })

  it('does not publish the old archive when publishing is first turned on', async () => {
    const t = await setup()
    t.setNow(new Date('2026-11-20T12:00:00Z'))
    t.box.progressNow = 1
    await t.bot.publishPending()
    expect(t.relay.events).toHaveLength(0)
    expect(t.state.data.stories['https://www.theguardian.com/x']!.publish).toBeUndefined()
    t.bot.close()
  })
})

describe('Bot.postAbout', () => {
  it('posts an inline memo that binds the bot key, and re-posts only on change', async () => {
    const t = await setup()
    await t.bot.postAbout()
    expect(t.relay.events).toHaveLength(1)
    const p = parseThingEvent(t.relay.events[0], MAX_INLINE_BUNDLE)
    if ('error' in p || !p.bundle) throw new Error('not inline')
    const r = admitBundle(parseBundle(p.bundle))
    if (r.status !== 'valid') throw new Error(r.status)
    expect(r.manifest.type).toBe('memo')
    expect(toHex(r.envelope.author.ek!)).toBe(t.identity.nostr.pubHex)
    expect(r.envelope.seq).toBe(1)
    await t.bot.postAbout()
    expect(t.relay.events).toHaveLength(1)
    t.config.about.description = 'Now with more news.'
    await t.bot.postAbout()
    expect(t.relay.events).toHaveLength(2)
    const p2 = parseThingEvent(t.relay.events[1], MAX_INLINE_BUNDLE)
    if ('error' in p2 || !p2.bundle) throw new Error('not inline')
    const r2 = admitBundle(parseBundle(p2.bundle))
    if (r2.status !== 'valid') throw new Error(r2.status)
    expect(r2.envelope.seq).toBe(2)
    expect(toHex(r2.envelope.prev!)).toBe(p.envelopeHash)
    t.bot.close()
  })
})

describe('Bot.listen and scraping on demand', () => {
  it('answers a sealed subscribe letter as it arrives, and scrapes what is wanted', async () => {
    const t = await setup({ scrape: 'subscribed' })
    expect(t.bot.sitesToScrape().map((s) => s.id)).toEqual(['bbc']) // `always`
    t.bot.listen()
    await settle()
    const ada = identityFromKey(secp256k1.utils.randomSecretKey())
    const tar = await buildSealedBundle(ada.signer, [t.identity.nostr.pub, ada.nostr.pub], {
      program: loadMemoProgram(),
      type: 'memo',
      args: jsToCbor({ to: 'Example News', from: 'Ada', subject: 'subscribe guardian', message: '', enclosures: [] }),
      created: Math.floor(Date.parse('2026-11-11T11:59:00Z') / 1000),
      enc: { e: NOSTR_ENC_SCHEME, ek: ada.nostr.pub }
    })
    t.relay.inject(await buildSealedEvent(tar, Math.floor(Date.parse('2026-11-11T11:59:30Z') / 1000)))
    await settle()
    expect(t.state.data.subscribers[ada.addressHex]?.sites).toEqual(['guardian'])
    expect(t.bot.sitesToScrape().map((s) => s.id)).toEqual(['guardian', 'bbc'])
    // the reply went back to the relay, sealed
    const reply = t.relay.events.find((e) => e.content && e.tags.some((x) => x[0] === 'thing-type' && x[1] === 'sealed') && e !== t.relay.events[0])
    expect(reply).toBeDefined()
    const opened = admitBundle(parseBundle(Uint8Array.from(Buffer.from(reply!.content, 'base64'))), { unsealer: ada.unsealer })
    expect(opened.status).toBe('valid')
    expect(t.state.data.relayCursors['wss://news.example']).toBeGreaterThan(0)
    t.bot.close()
  })
})
