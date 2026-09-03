// RSS 2.0 / Atom / RSS 1.0 (RDF) → a flat list of items. Only what discovery
// needs: link, title, dates, id. Everything else comes from the article page.
import { XMLParser } from 'fast-xml-parser'
import { resolveHttp } from './util/url.js'
import { normalizeText, decodeEntities } from './util/text.js'

export interface FeedItem {
  url: string
  title?: string
  /** Raw date string as published in the feed. */
  published?: string
  updated?: string
  id?: string
}

export interface ParsedFeed {
  title?: string
  items: FeedItem[]
}

export class FeedError extends Error {
  override name = 'FeedError'
}

const ARRAY_PATHS = new Set([
  'rss.channel.item',
  'feed.entry',
  'feed.entry.link',
  'feed.link',
  'rdf:RDF.item',
  'RDF.item'
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  processEntities: true,
  isArray: (_name, jpath) => typeof jpath === 'string' && ARRAY_PATHS.has(jpath)
})

type Node = Record<string, unknown>

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return str(v[0])
  if (typeof v === 'object') return str((v as Node)['#text'])
  return undefined
}

function stripTags(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  const t = normalizeText(decodeEntities(s.replace(/<[^>]*>/g, ' ')))
  return t || undefined
}

function attr(v: unknown, name: string): string | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return str((v as Node)[`@_${name}`])
  return undefined
}

function atomLink(entry: Node, base: string): string | undefined {
  const raw = entry['link']
  const links = Array.isArray(raw) ? raw : raw ? [raw] : []
  let fallback: string | undefined
  for (const l of links) {
    const href = attr(l, 'href') ?? (typeof l === 'string' ? l : undefined)
    if (!href) continue
    const rel = attr(l, 'rel') ?? 'alternate'
    const type = attr(l, 'type') ?? ''
    if (rel === 'alternate') {
      if (!type || /html/i.test(type)) return resolveHttp(href, base)
      fallback ??= resolveHttp(href, base)
    }
  }
  return fallback
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  let doc: Node
  try {
    doc = parser.parse(xml) as Node
  } catch (e) {
    throw new FeedError(`xml parse: ${(e as Error).message}`)
  }
  const items: FeedItem[] = []

  const rss = doc['rss'] as Node | undefined
  const channel = rss?.['channel'] as Node | undefined
  if (channel) {
    for (const it of (channel['item'] as Node[] | undefined) ?? []) {
      const link = str(it['link'])
      const guid = str(it['guid'])
      const url = resolveHttp(link, feedUrl) ?? (attr(it['guid'], 'isPermaLink') !== 'false' ? resolveHttp(guid, feedUrl) : undefined)
      if (!url) continue
      const item: FeedItem = { url }
      const title = stripTags(str(it['title']))
      if (title) item.title = title
      const pub = str(it['pubDate']) ?? str(it['dc:date'])
      if (pub) item.published = pub
      const upd = str(it['atom:updated']) ?? str(it['dcterms:modified'])
      if (upd) item.updated = upd
      if (guid) item.id = guid
      items.push(item)
    }
    const title = stripTags(str(channel['title']))
    return title ? { title, items } : { items }
  }

  const feed = doc['feed'] as Node | undefined
  if (feed) {
    for (const en of (feed['entry'] as Node[] | undefined) ?? []) {
      const url = atomLink(en, feedUrl)
      if (!url) continue
      const item: FeedItem = { url }
      const title = stripTags(str(en['title']))
      if (title) item.title = title
      const pub = str(en['published']) ?? str(en['issued'])
      if (pub) item.published = pub
      const upd = str(en['updated']) ?? str(en['modified'])
      if (upd) item.updated = upd
      const id = str(en['id'])
      if (id) item.id = id
      items.push(item)
    }
    const title = stripTags(str(feed['title']))
    return title ? { title, items } : { items }
  }

  const rdf = (doc['rdf:RDF'] ?? doc['RDF']) as Node | undefined
  if (rdf) {
    for (const it of (rdf['item'] as Node[] | undefined) ?? []) {
      const url = resolveHttp(str(it['link']), feedUrl) ?? resolveHttp(attr(it, 'rdf:about'), feedUrl)
      if (!url) continue
      const item: FeedItem = { url }
      const title = stripTags(str(it['title']))
      if (title) item.title = title
      const pub = str(it['dc:date'])
      if (pub) item.published = pub
      items.push(item)
    }
    const ch = rdf['channel'] as Node | undefined
    const title = stripTags(str(ch?.['title']))
    return title ? { title, items } : { items }
  }

  throw new FeedError('not an RSS, Atom or RDF feed')
}
