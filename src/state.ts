// What has been archived: canonical URL → version chain position, plus feed
// ETags. A JSON file behind a small class so a SQLite store could replace it.
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
}

export interface StateData {
  version: 1
  stories: Record<string, StoryRecord>
  /** discovered/fetched URL → canonical URL */
  aliases: Record<string, string>
  feeds: Record<string, FeedMeta>
}

const empty = (): StateData => ({ version: 1, stories: {}, aliases: {}, feeds: {} })

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
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateData>
    if (raw.version !== 1) throw new Error(`${file}: unsupported state version ${String(raw.version)}`)
    return new StateStore(file, { version: 1, stories: raw.stories ?? {}, aliases: raw.aliases ?? {}, feeds: raw.feeds ?? {} })
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
