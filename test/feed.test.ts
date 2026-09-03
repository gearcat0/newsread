import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseFeed, FeedError } from '../src/feed.js'
import { FeedDiscoverer, type FeedMeta } from '../src/discover.js'
import { fakeHttp } from './helpers/fakeHttp.js'
import type { Site } from '../src/config.js'

const fx = (n: string): string => readFileSync(new URL(`./fixtures/feeds/${n}`, import.meta.url), 'utf8')

describe('parseFeed', () => {
  it('RSS 2.0: CDATA titles, entities, relative links, guid permalinks', () => {
    const f = parseFeed(fx('rss2.xml'), 'https://example.com/feed.xml')
    expect(f.title).toBe('The Example Times & Herald')
    expect(f.items.map((i) => i.url)).toEqual([
      'https://example.com/story/1?utm_source=rss',
      'https://example.com/story/2',
      'https://example.com/story/3'
    ])
    expect(f.items[0]!.title).toBe('Scaffolding goes up on Monday & Tuesday')
    expect(f.items[0]!.published).toBe('Thu, 03 Sep 2026 06:00:00 GMT')
    expect(f.items[0]!.id).toBe('tag:example.com,2026:1')
  })
  it('Atom: alternate link selection, html titles stripped, dates', () => {
    const f = parseFeed(fx('atom.xml'), 'https://example.com/feed.atom')
    expect(f.title).toBe('Example Atom')
    expect(f.items.map((i) => i.url)).toEqual(['https://example.com/story/10', 'https://example.com/story/11'])
    expect(f.items[0]!.title).toBe('Works begin at the north face')
    expect(f.items[0]!.published).toBe('2026-09-03T06:00:00Z')
    expect(f.items[0]!.updated).toBe('2026-09-04T07:00:00Z')
    expect(f.items[1]!.published).toBeUndefined()
  })
  it('RDF / RSS 1.0', () => {
    const f = parseFeed(fx('rdf.xml'), 'https://example.com/rss1')
    expect(f.title).toBe('Example RSS 1.0')
    expect(f.items).toEqual([{ url: 'https://example.com/story/20', title: 'RDF story', published: '2026-09-03T06:00:00+02:00' }])
  })
  it('rejects non-feeds', () => {
    expect(() => parseFeed('<html><body>nope</body></html>', 'https://x/')).toThrow(FeedError)
  })
})

describe('FeedDiscoverer', () => {
  const site: Site = {
    id: 'ex',
    publisher: 'Example',
    hosts: ['example.com'],
    feeds: ['https://example.com/feed.xml', 'https://example.com/feed.atom'],
    urlFilter: (u) => !u.pathname.endsWith('/11')
  }
  it('merges feeds, normalises and dedupes URLs, applies urlFilter, records etags', async () => {
    const http = fakeHttp({
      'https://example.com/feed.xml': { body: fx('rss2.xml'), headers: { etag: '"A"', 'last-modified': 'Thu, 03 Sep 2026 06:00:00 GMT' } },
      'https://example.com/feed.atom': { body: fx('atom.xml') }
    })
    const store = new Map<string, { etag?: string; lastModified?: string; lastChecked?: string }>()
    const logs: string[] = []
    const found = await new FeedDiscoverer().discover(site, {
      http,
      feedState: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
      now: () => new Date('2026-09-04T00:00:00Z'),
      log: (m) => logs.push(m)
    })
    expect(found.map((d) => d.url)).toEqual([
      'https://example.com/story/1', // utm stripped
      'https://example.com/story/2',
      'https://example.com/story/3',
      'https://example.com/story/10'
      // /11 filtered out
    ])
    expect(found[0]!.source).toBe('https://example.com/feed.xml')
    expect(store.get('https://example.com/feed.xml')).toEqual({
      etag: '"A"',
      lastModified: 'Thu, 03 Sep 2026 06:00:00 GMT',
      lastChecked: '2026-09-04T00:00:00.000Z'
    })
    expect(logs).toEqual([])
  })
  it('sends conditional headers and treats 304 as nothing new', async () => {
    const http = fakeHttp({
      'https://example.com/feed.xml': (opts) => (opts.etag === '"A"' ? { status: 304 } : { body: fx('rss2.xml') }),
      'https://example.com/feed.atom': { status: 500 }
    })
    const store = new Map<string, FeedMeta>([['https://example.com/feed.xml', { etag: '"A"' }]])
    const logs: string[] = []
    const found = await new FeedDiscoverer().discover(site, {
      http,
      feedState: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
      now: () => new Date(),
      log: (m) => logs.push(m)
    })
    expect(found).toEqual([])
    expect(http.calls[0]!.opts.etag).toBe('"A"')
    expect(store.get('https://example.com/feed.xml')?.etag).toBe('"A"')
    expect(logs).toEqual(['feed https://example.com/feed.atom: HTTP 500'])
  })
})
