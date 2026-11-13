// What has been archived: canonical URL → version chain position, plus feed
// ETags, how far each story got through publishing, who has subscribed, and
// where each relay was read up to. A JSON file behind a small class so a
// SQLite store could replace it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FeedMeta, FeedStateAccess } from './discover.js'
import { hash, toHex } from './souspli.js'
import { utf8 } from './util/bytes.js'

export interface StoryRecord {
  siteId: string
  /** envelope.path — stable per story */
  path: string
  seq: number
  envelopeHash: string
  manifestHash: string
  contentHash: string
  firstSeen: string
  lastFetched: string
  lastEmitted: string
  outFile: string
  title?: string
  /** Set once the story is staged for BitTorrent; absent when publishing is off. */
  publish?: PublishRecord
}

export interface BoxRecord {
  added?: string
  /** 0..1 as last polled */
  progress?: number
  error?: string
}

export interface PublishRecord {
  /** of the version this record describes — an edit restarts publishing */
  envelopeHash: string
  infohash: string
  magnet: string
  /** file name inside the torrent */
  name: string
  length: number
  torrentFile: string
  webseedUrl?: string
  staged: string
  boxes: Record<string, BoxRecord>
  /** relay URL → ISO time the relay acknowledged the pointer */
  announced: Record<string, string>
  lastError?: string
}

export type SiteChoice = 'all' | string[]

export interface Subscriber {
  /** The subscriber's Nostr/encryption key (their letter's Author.ek): replies are sealed to it. */
  ek: string
  sites: SiteChoice
  /** `created` of the letter that set this, unix seconds — an older letter never overrides a newer one. */
  updated: number
  /** envelope hash of that letter */
  lastRequest: string
}

/** The bot's own public memo, kept as one chain so readers see one row. */
export interface AboutRecord {
  path: string
  seq: number
  envelopeHash: string
  /** hash of the text it carried: a change re-posts */
  contentHash: string
  /** the bundle on disk, so an unacknowledged relay gets the same bytes */
  file: string
  posted: string
  /** relay URL → ISO ack time */
  announced: Record<string, string>
}

export interface StateData {
  version: 2
  stories: Record<string, StoryRecord>
  /** discovered/fetched URL → canonical URL */
  aliases: Record<string, string>
  feeds: Record<string, FeedMeta>
  /** author key (hex eth address) → their subscription */
  subscribers: Record<string, Subscriber>
  /** relay URL → `created_at` of the newest event handled there */
  relayCursors: Record<string, number>
  /** envelope hashes of inbox letters already acted on, newest last (bounded) */
  inboxSeen: string[]
  about?: AboutRecord
}

/** How many handled inbox letters to remember. A relay keeps events far
 *  longer than this matters; `updated` still stops a replay from undoing a
 *  newer request. */
export const INBOX_SEEN_MAX = 5000

const empty = (): StateData => ({ version: 2, stories: {}, aliases: {}, feeds: {}, subscribers: {}, relayCursors: {}, inboxSeen: [] })

/** Stable chain path for a story: `news/<host>/<16 hex of sha256(canonical url)>`. */
export function storyPath(canonicalUrl: string): string {
  const host = new URL(canonicalUrl).hostname
  return `news/${host}/${toHex(hash(utf8(canonicalUrl))).slice(0, 16)}`
}

export class StateStore {
  readonly data: StateData
  readonly feedState: FeedStateAccess

  constructor(
    readonly file?: string,
    data: StateData = empty()
  ) {
    this.data = data
    this.feedState = {
      get: (url) => this.data.feeds[url],
      set: (url, meta) => {
        this.data.feeds[url] = meta
      }
    }
  }

  static load(file: string): StateStore {
    if (!existsSync(file)) return new StateStore(file)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Omit<Partial<StateData>, 'version'> & { version?: number }
    // v1 → v2 only adds fields, so migrating is filling them in.
    if (raw.version !== 1 && raw.version !== 2) throw new Error(`${file}: unsupported state version ${String(raw.version)}`)
    return new StateStore(file, {
      version: 2,
      stories: raw.stories ?? {},
      aliases: raw.aliases ?? {},
      feeds: raw.feeds ?? {},
      subscribers: raw.subscribers ?? {},
      relayCursors: raw.relayCursors ?? {},
      inboxSeen: raw.inboxSeen ?? [],
      ...(raw.about ? { about: raw.about } : {})
    })
  }

  getStory(url: string): StoryRecord | undefined {
    return this.data.stories[url] ?? this.data.stories[this.data.aliases[url] ?? '']
  }

  setStory(canonicalUrl: string, rec: StoryRecord): void {
    this.data.stories[canonicalUrl] = rec
  }

  setAlias(url: string, canonicalUrl: string): void {
    if (url !== canonicalUrl) this.data.aliases[url] = canonicalUrl
  }

  /** Stories whose current version still has publishing work to do. */
  pendingPublish(relays: string[]): [string, StoryRecord][] {
    return Object.entries(this.data.stories).filter(
      ([, r]) => !r.publish || r.publish.envelopeHash !== r.envelopeHash || relays.some((u) => !r.publish!.announced[u])
    )
  }

  hasSeen(envelopeHash: string): boolean {
    return this.data.inboxSeen.includes(envelopeHash)
  }

  markSeen(envelopeHash: string): void {
    if (this.hasSeen(envelopeHash)) return
    this.data.inboxSeen.push(envelopeHash)
    if (this.data.inboxSeen.length > INBOX_SEEN_MAX) this.data.inboxSeen.splice(0, this.data.inboxSeen.length - INBOX_SEEN_MAX)
  }

  get storyCount(): number {
    return Object.keys(this.data.stories).length
  }

  save(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}
