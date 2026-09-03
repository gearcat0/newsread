// Article metadata: JSON-LD → OpenGraph/meta → Readability fallbacks, with the
// site config authoritative for publisher/section/language. Every value is a
// claim recorded as found; nothing here verifies anything.
import type { Site } from '../config.js'
import type { ArticleMeta, IrDocument, IrImage } from '../ir.js'
import { inlineText } from '../ir.js'
import { extractJsonLd } from './jsonld.js'
import type { ReadabilityMeta } from './body.js'
import { toIsoDate, localIsoDate } from '../util/dates.js'
import { decodeEntities, dedupeCi, normalizeText } from '../util/text.js'
import { hostMatches, isHttpUrl, normalizeUrl, resolveHttp } from '../util/url.js'

export interface MetaInputs {
  site: Site
  fetchedUrl: string
  now: Date
  feed?: { title?: string; published?: string; updated?: string }
  readability?: ReadabilityMeta
}

const MAX_AUTHORS = 16
const MAX_KEYWORDS = 20

function content(doc: Document, selector: string): string | undefined {
  const raw = doc.querySelector(selector)?.getAttribute('content')
  if (!raw) return undefined
  const t = normalizeText(decodeEntities(raw))
  return t || undefined
}

function contents(doc: Document, selector: string): string[] {
  return Array.from(doc.querySelectorAll(selector))
    .map((el) => normalizeText(decodeEntities(el.getAttribute('content') ?? '')))
    .filter(Boolean)
}

const og = (doc: Document, p: string): string | undefined =>
  content(doc, `meta[property="og:${p}"]`) ?? content(doc, `meta[name="og:${p}"]`)
const art = (doc: Document, p: string): string | undefined =>
  content(doc, `meta[property="article:${p}"]`) ?? content(doc, `meta[name="article:${p}"]`)
const named = (doc: Document, n: string): string | undefined =>
  content(doc, `meta[name="${n}"]`) ?? content(doc, `meta[property="${n}"]`)

export function splitAuthors(raw: string | undefined): string[] {
  if (!raw) return []
  const s = normalizeText(raw).replace(/^by\s+/i, '')
  return s
    .split(/\s*(?:,|;|\band\b|&|\|)\s*/i)
    .map((a) => normalizeText(a).replace(/^by\s+/i, ''))
    .filter((a) => a && !isHttpUrl(a) && a.length <= 80)
}

const SEPARATORS = [' - ', ' | ', ' — ', ' – ', ' : ', ': ', ' · ']

/** Strip a trailing ` - Publisher` / ` | Publisher` from a <title>. */
export function stripTitleSuffix(title: string, names: readonly (string | undefined)[]): string {
  const lower = title.toLowerCase()
  for (const n of names) {
    if (!n) continue
    const nl = n.toLowerCase()
    for (const sep of SEPARATORS) {
      if (lower.endsWith(sep + nl)) return title.slice(0, title.length - sep.length - n.length).trim()
    }
  }
  return title
}

function primaryLang(v: string | undefined): string | undefined {
  if (!v) return undefined
  const m = /^([a-z]{2,3})(?:[-_]|$)/i.exec(v.trim())
  return m ? m[1]!.toLowerCase() : undefined
}

function firstDefined<T>(...vals: (T | undefined)[]): T | undefined {
  return vals.find((v) => v !== undefined)
}

export function extractMeta(doc: Document, inp: MetaInputs): ArticleMeta {
  const { site, readability: rd } = inp
  const ld = extractJsonLd(doc)
  const now = inp.now

  const publisher = firstDefined(site.publisher, ld?.publisher, og(doc, 'site_name'), rd?.siteName, inp.feed?.title)

  const rawTitle = normalizeText(decodeEntities(doc.querySelector('title')?.textContent ?? ''))
  const title = firstDefined(
    ld?.headline,
    og(doc, 'title'),
    named(doc, 'twitter:title'),
    rawTitle ? stripTitleSuffix(rawTitle, [publisher, og(doc, 'site_name'), rd?.siteName]) : undefined,
    rd?.title
  )

  const deck = firstDefined(
    ld?.alternativeHeadline,
    ld?.description,
    og(doc, 'description'),
    named(doc, 'description'),
    named(doc, 'twitter:description'),
    rd?.excerpt && rd.excerpt.length <= 300 ? normalizeText(rd.excerpt) : undefined
  )

  let authors: string[] = ld?.authors ?? []
  if (!authors.length) authors = splitAuthors(named(doc, 'author'))
  if (!authors.length) authors = contents(doc, 'meta[property="article:author"]').flatMap((a) => splitAuthors(a))
  if (!authors.length) authors = splitAuthors(named(doc, 'parsely-author') ?? named(doc, 'sailthru.author') ?? named(doc, 'dc.creator'))
  if (!authors.length) authors = splitAuthors(rd?.byline ?? undefined)
  authors = dedupeCi(authors).slice(0, MAX_AUTHORS)

  const section = firstDefined(
    typeof site.section === 'string' ? site.section : undefined,
    ld?.section,
    art(doc, 'section'),
    named(doc, 'parsely-section')
  )

  const published = firstDefined(
    toIsoDate(ld?.datePublished, now),
    toIsoDate(art(doc, 'published_time'), now),
    toIsoDate(doc.querySelector('time[itemprop="datePublished"], time[pubdate], time[datetime]')?.getAttribute('datetime'), now),
    toIsoDate(named(doc, 'parsely-pub-date') ?? named(doc, 'sailthru.date') ?? named(doc, 'dc.date') ?? named(doc, 'date'), now),
    toIsoDate(inp.feed?.published, now),
    toIsoDate(rd?.publishedTime, now)
  )
  let updated = firstDefined(
    toIsoDate(ld?.dateModified, now),
    toIsoDate(art(doc, 'modified_time'), now),
    toIsoDate(og(doc, 'updated_time'), now),
    toIsoDate(doc.querySelector('time[itemprop="dateModified"]')?.getAttribute('datetime'), now)
  )
  if (updated && updated === published) updated = undefined

  const language = firstDefined(
    primaryLang(doc.documentElement?.getAttribute('lang') ?? undefined),
    primaryLang(ld?.inLanguage),
    primaryLang(og(doc, 'locale')),
    primaryLang(named(doc, 'dc.language') ?? named(doc, 'language')),
    primaryLang(rd?.lang),
    site.language
  )

  const rights = firstDefined(
    ld?.copyrightNotice,
    ld?.copyrightYear && ld.copyrightHolder ? `© ${ld.copyrightYear} ${ld.copyrightHolder}` : undefined,
    named(doc, 'copyright') ?? named(doc, 'dc.rights') ?? named(doc, 'dcterms.rights')
  )

  let keywords: string[] = ld?.keywords ?? []
  if (!keywords.length) keywords = (named(doc, 'news_keywords') ?? '').split(',').map(normalizeText).filter(Boolean)
  if (!keywords.length) keywords = (named(doc, 'keywords') ?? '').split(',').map(normalizeText).filter(Boolean)
  if (!keywords.length) keywords = contents(doc, 'meta[property="article:tag"]')
  keywords = dedupeCi(keywords).slice(0, MAX_KEYWORDS)

  const location = ld?.location

  // Canonical URL: must be http(s) on one of the site's hosts.
  const fetched = normalizeUrl(inp.fetchedUrl) ?? inp.fetchedUrl
  const candidates = [
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    og(doc, 'url'),
    ld?.mainEntityOfPage
  ]
  let canonicalUrl = fetched
  for (const c of candidates) {
    const abs = resolveHttp(c, inp.fetchedUrl)
    if (!abs) continue
    const norm = normalizeUrl(abs)
    if (!norm) continue
    if (site.hosts.length && !hostMatches(new URL(norm).hostname, site.hosts)) continue
    canonicalUrl = norm
    break
  }

  const leadUrl = firstDefined(ld?.images[0], og(doc, 'image'), named(doc, 'twitter:image'))
  const leadImage: IrImage | undefined = leadUrl && resolveHttp(leadUrl, inp.fetchedUrl)
    ? { candidates: [{ url: resolveHttp(leadUrl, inp.fetchedUrl)! }], alt: og(doc, 'image:alt') ?? '', caption: [] }
    : undefined

  let meta: ArticleMeta = { authors, keywords, canonicalUrl, fetchedUrl: inp.fetchedUrl }
  if (title) meta.title = title
  if (deck) meta.deck = deck
  if (publisher) meta.publisher = publisher
  if (section) meta.section = section
  if (location) meta.location = location
  if (published) meta.published = published
  if (updated) meta.updated = updated
  if (language) meta.language = language
  if (rights) meta.rights = rights
  if (leadImage) meta.leadImage = leadImage

  const url = new URL(inp.fetchedUrl)
  if (typeof site.section === 'function') {
    const s = site.section(doc, url)
    if (s) meta.section = s
  }
  if (typeof site.metadata === 'function') meta = site.metadata(meta, doc, url)
  else if (site.metadata) {
    for (const [k, v] of Object.entries(site.metadata)) if (v !== undefined) (meta as unknown as Record<string, unknown>)[k] = v
  }
  return meta
}

const DATELINE = /^([A-Z][A-Z .'’-]{2,40}?)\s+[—–-]\s+(?=\S)/

/** Pull a leading `NAIROBI — ` dateline out of the first paragraph into
 *  meta.location (when not already set) and strip it from the text. */
export function applyDateline(ir: IrDocument): void {
  // The standfirst is often the first paragraph; look at the first few.
  const paragraphs = ir.blocks.filter((b) => b.kind === 'paragraph').slice(0, 3)
  for (const p of paragraphs) {
    if (p.kind !== 'paragraph') continue
    const lead = p.inlines[0]
    if (!lead || lead.kind !== 'text') continue
    const m = DATELINE.exec(lead.text)
    if (!m) continue
    const place = m[1]!.trim()
    // Guard against ALL-CAPS sentence openers that are not places.
    if (place.split(' ').length > 4) return
    if (!ir.meta.location) ir.meta.location = place
    lead.text = lead.text.slice(m[0].length)
    if (!inlineText(p.inlines).trim()) ir.blocks.splice(ir.blocks.indexOf(p), 1)
    return
  }
}

export { localIsoDate }
