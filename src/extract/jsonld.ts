// schema.org JSON-LD: the most reliable metadata source when present.
import { decodeEntities, normalizeText } from '../util/text.js'

export interface LdArticle {
  type: string
  headline?: string
  alternativeHeadline?: string
  description?: string
  authors: string[]
  publisher?: string
  section?: string
  datePublished?: string
  dateModified?: string
  inLanguage?: string
  keywords: string[]
  copyrightNotice?: string
  copyrightYear?: string
  copyrightHolder?: string
  location?: string
  mainEntityOfPage?: string
  images: string[]
}

type Node = Record<string, unknown>

const ARTICLE_TYPES = new Set([
  'NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle', 'OpinionNewsArticle', 'BackgroundNewsArticle',
  'ReviewNewsArticle', 'Article', 'BlogPosting', 'TechArticle', 'ScholarlyArticle', 'Report', 'LiveBlogPosting'
])

function isNode(v: unknown): v is Node {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function collect(v: unknown, out: Node[]): void {
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out)
    return
  }
  if (!isNode(v)) return
  out.push(v)
  if (v['@graph']) collect(v['@graph'], out)
  if (v['mainEntity']) collect(v['mainEntity'], out)
}

function typesOf(n: Node): string[] {
  const t = n['@type']
  if (typeof t === 'string') return [t.replace(/^https?:\/\/schema\.org\//, '')]
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^https?:\/\/schema\.org\//, ''))
  return []
}

// JSON-LD strings are frequently HTML-escaped by publishers' templating
// (`&apos;`, `&amp;`, `&#39;`), and JSON.parse leaves those alone.
function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = normalizeText(decodeEntities(v))
    return t || undefined
  }
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return str(v[0])
  if (isNode(v) && typeof v['@value'] === 'string') return str(v['@value'])
  return undefined
}

function nameOf(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v)
  if (isNode(v)) return str(v['name']) ?? str(v['alternateName'])
  return undefined
}

function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(nameOf).filter((x): x is string => !!x)
  const n = nameOf(v)
  return n ? [n] : []
}

function urlOf(v: unknown): string | undefined {
  if (typeof v === 'string') return decodeEntities(v).trim() || undefined
  if (isNode(v)) return str(v['url']) ?? str(v['contentUrl']) ?? str(v['@id'])
  if (Array.isArray(v)) return urlOf(v[0])
  return undefined
}

function urlsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(urlOf).filter((x): x is string => !!x)
  const u = urlOf(v)
  return u ? [u] : []
}

function keywordsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keywordsOf)
  if (typeof v === 'string') return decodeEntities(v).split(',').map((s) => normalizeText(s)).filter(Boolean)
  if (isNode(v)) return namesOf(v)
  return []
}

export function parseJsonLdNodes(doc: Document): Node[] {
  const nodes: Node[] = []
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = (s.textContent ?? '').trim().replace(/^<!--/, '').replace(/-->$/, '').trim()
    if (!raw) continue
    try {
      collect(JSON.parse(raw), nodes)
    } catch {
      /* malformed block: ignore */
    }
  }
  return nodes
}

export function extractJsonLd(doc: Document): LdArticle | undefined {
  const nodes = parseJsonLdNodes(doc)
  const node = nodes.find((n) => typesOf(n).some((t) => ARTICLE_TYPES.has(t)))
  if (!node) return undefined
  const art: LdArticle = {
    type: typesOf(node).find((t) => ARTICLE_TYPES.has(t)) ?? 'Article',
    authors: namesOf(node['author'] ?? node['creator']),
    keywords: keywordsOf(node['keywords']),
    images: urlsOf(node['image'] ?? node['thumbnailUrl'])
  }
  const set = (k: keyof LdArticle, v: string | undefined): void => {
    if (v) (art as unknown as Record<string, unknown>)[k] = v
  }
  set('headline', str(node['headline']) ?? str(node['name']))
  set('alternativeHeadline', str(node['alternativeHeadline']))
  set('description', str(node['description']))
  set('publisher', nameOf(node['publisher']) ?? nameOf(node['sourceOrganization']))
  set('section', str(node['articleSection']))
  set('datePublished', str(node['datePublished']))
  set('dateModified', str(node['dateModified']))
  set('inLanguage', typeof node['inLanguage'] === 'string' ? node['inLanguage'] : nameOf(node['inLanguage']))
  set('copyrightNotice', str(node['copyrightNotice']))
  set('copyrightYear', str(node['copyrightYear']))
  set('copyrightHolder', nameOf(node['copyrightHolder']))
  set('location', nameOf(node['contentLocation']) ?? nameOf(node['locationCreated']))
  set('mainEntityOfPage', urlOf(node['mainEntityOfPage']) ?? str(node['url']))
  return art
}
