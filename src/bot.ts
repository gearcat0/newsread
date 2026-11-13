// The long-running side of newsread: publish what was scraped, announce it,
// keep the about memo current, and answer sealed subscribe letters.
//
// Everything is driven from the state file, so each step is a retry of
// itself: a crash between staging and announcing resumes where it stopped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, expandPath } from './config.js'
import type { Identity } from './identity.js'
import { handleInboxEvent, type InboxOutcome } from './inbox.js'
import { aboutArgs, buildAbout, memoContentHash } from './memo.js'
import { inlineEvent, pointerEvent } from './nostr/announce.js'
import { RelayClient, type RelayClientOptions } from './nostr/relay.js'
import type { Logger } from './pipeline.js'
import { type Publisher, poll, stage } from './publish/index.js'
import { THING_KIND, type NostrEvent } from './souspli.js'
import type { StateStore, StoryRecord } from './state.js'
import { wantedSites } from './subscribe.js'

export interface BotOptions {
  config: Config
  identity: Identity
  state: StateStore
  publisher?: Publisher
  log: Logger
  now?: () => Date
  relay?: RelayClientOptions
}

const DAY_MS = 86_400_000
/** On the first read of a relay, look back this far for letters to us. */
const FIRST_LOOKBACK_S = 30 * 86_400

export class Bot {
  readonly relays: RelayClient[]
  readonly #now: () => Date
  #publishing = false

  constructor(readonly o: BotOptions) {
    this.#now = o.now ?? (() => new Date())
    this.relays = o.config.relays.map((u) => new RelayClient(u, { log: o.log, ...o.relay }))
  }

  /** Sites to scrape this tick. */
  sitesToScrape(): Config['sites'] {
    const { config, state } = this.o
    if (config.scrape === 'all') return config.sites
    const wanted = wantedSites(state.data.subscribers, config.sites.map((s) => s.id))
    return config.sites.filter((s) => s.always || wanted.has(s.id))
  }

  async #postEverywhere(ev: NostrEvent, done: Record<string, string>, what: string): Promise<void> {
    for (const r of this.relays) {
      if (done[r.url]) continue
      const res = await r.publish(ev)
      if (res.ok) done[r.url] = this.#now().toISOString()
      else this.o.log.warn(`${r.url}: refused ${what}: ${res.message}`)
    }
  }

  /** Stage, poll and announce every story that still needs it. Returns how many were announced everywhere. */
  async publishPending(): Promise<number> {
    const { publisher, state, config, log } = this.o
    if (!publisher || this.#publishing) return 0
    this.#publishing = true
    let finished = 0
    try {
      const cutoff = this.#now().getTime() - config.publish!.backlogDays * DAY_MS
      const urls = config.relays
      for (const [url, story] of state.pendingPublish(urls)) {
        if (Date.parse(story.lastEmitted) < cutoff) continue
        try {
          if (await this.#publishOne(story)) finished++
        } catch (e) {
          story.publish = story.publish ? { ...story.publish, lastError: (e as Error).message } : story.publish
          log.warn(`publish ${url}: ${(e as Error).message}`)
        }
        state.save()
      }
    } finally {
      this.#publishing = false
    }
    return finished
  }

  async #publishOne(story: StoryRecord): Promise<boolean> {
    const { publisher, log } = this.o
    const now = this.#now()
    if (!story.publish || story.publish.envelopeHash !== story.envelopeHash) {
      if (!existsSync(story.outFile)) throw new Error(`${story.outFile} is gone`)
      const tar = new Uint8Array(readFileSync(story.outFile))
      story.publish = await stage(publisher!, { tar, envelopeHash: story.envelopeHash, type: 'article', outFile: story.outFile }, now, log)
    }
    const rec = story.publish
    if (this.relays.every((r) => rec.announced[r.url])) return true
    if ((await poll(publisher!, rec, now, log)) !== 'ready') return false
    const ev = await pointerEvent(this.o.identity.nostr, {
      envelopeHash: story.envelopeHash,
      type: 'article',
      feed: story.siteId,
      locator: rec.magnet,
      createdAt: Math.floor(now.getTime() / 1000)
    })
    await this.#postEverywhere(ev, rec.announced, story.title ? JSON.stringify(story.title) : story.envelopeHash)
    const all = this.relays.every((r) => rec.announced[r.url])
    if (all) log.info(`announced ${story.title ? JSON.stringify(story.title) : story.envelopeHash} on ${this.relays.length} relay${this.relays.length === 1 ? '' : 's'}`)
    return all
  }

  /** Post the about memo if it is new, changed, stale, or some relay never took it. */
  async postAbout(): Promise<void> {
    const { config, state, identity, log } = this.o
    if (!this.relays.length) return
    const args = aboutArgs(config)
    const h = memoContentHash(args)
    const now = this.#now()
    let rec = state.data.about
    const stale = rec && now.getTime() - Date.parse(rec.posted) > config.about.repostDays * DAY_MS
    if (!rec || rec.contentHash !== h || stale || !existsSync(rec.file)) {
      const chain = rec ? { path: rec.path, seq: rec.seq + 1, prev: rec.envelopeHash } : { path: `bot/${identity.addressHex}/about`, seq: 1 }
      const built = await buildAbout(identity, args, chain, Math.floor(now.getTime() / 1000))
      const dir = join(expandPath(config.outDir), '_bot')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `about-${chain.seq}-${built.envelopeHash.slice(0, 8)}.thing`)
      writeFileSync(file, built.tar)
      rec = { path: chain.path, seq: chain.seq, envelopeHash: built.envelopeHash, contentHash: h, file, posted: now.toISOString(), announced: {} }
      state.data.about = rec
      state.save()
    }
    if (this.relays.every((r) => rec.announced[r.url])) return
    const tar = new Uint8Array(readFileSync(rec.file))
    const ev = await inlineEvent(identity.nostr, tar, rec.envelopeHash, 'memo', Math.floor(Date.parse(rec.posted) / 1000))
    await this.#postEverywhere(ev, rec.announced, 'the about memo')
    state.save()
    if (this.relays.every((r) => rec.announced[r.url])) log.info(`about memo v${rec.seq} is on every relay`)
  }

  #since(url: string): number {
    const c = this.o.state.data.relayCursors[url]
    return c ?? Math.floor(this.#now().getTime() / 1000) - FIRST_LOOKBACK_S
  }

  async #onInbox(relay: RelayClient, raw: unknown): Promise<InboxOutcome> {
    const { state, log } = this.o
    const out = await handleInboxEvent(raw, { config: this.o.config, identity: this.o.identity, state, now: this.#now })
    const at = (raw as { created_at?: unknown } | null)?.created_at
    // Advance the cursor only to now: a relay should not hand us the future,
    // and believing it would make us skip everything until then.
    if (typeof at === 'number') {
      const capped = Math.min(at, Math.floor(this.#now().getTime() / 1000))
      if (capped > (state.data.relayCursors[relay.url] ?? 0)) state.data.relayCursors[relay.url] = capped
    }
    if (out.kind === 'handled') {
      log.info(`inbox: ${out.action} from ${out.author}`)
      if (out.reply) await this.#postEverywhere(out.reply, {}, 'a reply')
    } else if (out.kind === 'not-a-request') log.info(`inbox: a sealed letter from ${out.author} that is not a request; ignored`)
    else if (out.kind === 'stale') log.debug(`inbox: an older request from ${out.author}; ignored`)
    else if (out.kind === 'ignored') log.debug(`inbox: ignored event (${out.reason})`)
    if (out.kind !== 'not-for-me' && out.kind !== 'ignored') state.save()
    return out
  }

  #filter(url: string): { kinds: number[]; '#t': string[]; since: number; limit: number } {
    return { kinds: [THING_KIND], '#t': ['thing'], since: this.#since(url), limit: 1000 }
  }

  /** Read every relay once, up to EOSE. For cron use. */
  async readInboxOnce(): Promise<InboxOutcome[]> {
    const outs: InboxOutcome[] = []
    for (const r of this.relays) {
      const queue: Promise<void>[] = []
      const res = await r.fetchStored([this.#filter(r.url)], (ev) => {
        queue.push(this.#onInbox(r, ev).then((o) => void outs.push(o)))
      })
      await Promise.all(queue)
      if (res === 'timeout') this.o.log.warn(`${r.url}: no EOSE in time`)
    }
    this.o.state.save()
    return outs
  }

  /** Keep a subscription open on every relay; letters are handled as they arrive. */
  listen(): void {
    for (const r of this.relays) {
      // Serialise per relay so state updates and the cursor stay in order.
      let chain: Promise<unknown> = Promise.resolve()
      r.subscribe('inbox', () => [this.#filter(r.url)], (ev) => {
        chain = chain.then(() => this.#onInbox(r, ev)).catch((e: Error) => this.o.log.warn(`inbox: ${e.message}`))
      })
    }
  }

  close(): void {
    for (const r of this.relays) r.close()
  }
}
