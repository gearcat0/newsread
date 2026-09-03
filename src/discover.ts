// Discovery: which URLs should this run look at? v1 ships feeds only, behind an
// interface so section-page crawling can be added without touching the pipeline.
import type { Site } from './config.js'
import type { HttpClient } from './http.js'
import { parseFeed } from './feed.js'
import { normalizeUrl } from './util/url.js'

export interface Discovered {
  /** Normalised URL as it appeared in the source (canonical resolution happens later). */
  url: string
  title?: string
  published?: string
  updated?: string
  source: string
}

export interface FeedMeta {
  etag?: string
  lastModified?: string
  lastChecked?: string
}

export interface FeedStateAccess {
  get(feedUrl: string): FeedMeta | undefined
  set(feedUrl: string, meta: FeedMeta): void
}

export interface DiscoverContext {
  http: HttpClient
  feedState: FeedStateAccess
  now: () => Date
  log: (msg: string) => void
}

export interface Discoverer {
  discover(site: Site, ctx: DiscoverContext): Promise<Discovered[]>
}

const FEED_ACCEPT = 'application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5'

export class FeedDiscoverer implements Discoverer {
  async discover(site: Site, ctx: DiscoverContext): Promise<Discovered[]> {
    const out: Discovered[] = []
    const seen = new Set<string>()
    for (const feedUrl of site.feeds) {
      const prev = ctx.feedState.get(feedUrl)
      let res
      try {
        res = await ctx.http.get(feedUrl, {
          accept: FEED_ACCEPT,
          ...(prev?.etag ? { etag: prev.etag } : {}),
          ...(prev?.lastModified ? { lastModified: prev.lastModified } : {})
        })
      } catch (e) {
        ctx.log(`feed ${feedUrl}: ${(e as Error).message}`)
        continue
      }
      const checked = ctx.now().toISOString()
      if (res.status === 304) {
        ctx.feedState.set(feedUrl, { ...prev, lastChecked: checked })
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        ctx.log(`feed ${feedUrl}: HTTP ${res.status}`)
        continue
      }
      const meta: FeedMeta = { lastChecked: checked }
      const etag = res.headers.get('etag')
      const lm = res.headers.get('last-modified')
      if (etag) meta.etag = etag
      if (lm) meta.lastModified = lm
      ctx.feedState.set(feedUrl, meta)
      let parsed
      try {
        parsed = parseFeed(new TextDecoder().decode(res.body), res.url)
      } catch (e) {
        ctx.log(`feed ${feedUrl}: ${(e as Error).message}`)
        continue
      }
      for (const item of parsed.items) {
        const url = normalizeUrl(item.url)
        if (!url || seen.has(url)) continue
        if (site.urlFilter && !site.urlFilter(new URL(url))) continue
        seen.add(url)
        const d: Discovered = { url, source: feedUrl }
        if (item.title) d.title = item.title
        if (item.published) d.published = item.published
        if (item.updated) d.updated = item.updated
        out.push(d)
      }
    }
    return out
  }
}
