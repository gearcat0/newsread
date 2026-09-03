// URL hygiene. The canonical URL is the story's identity (state key, version
// chain path), so normalisation must be deterministic and conservative: strip
// only well-known tracking parameters, never anything that could select content.

const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', '_ga', '_gl',
  'ref', 'ref_src', 'ref_url', 'ito', 'cmp', 'smid', 'ocid', 'share', 'sref', 'srnd', 'taid',
  'wpisrc', 'wpmk', 'ftag', 'intcmp', 'int_source', 'int_medium', 'int_campaign', 'xtor'
])
const TRACKING_PREFIX = ['utm_', 'ns_', 'at_', 'mkt_', 'pk_', 'piwik_', 'hsa_', 'ito_', 'cmpid']

export function isTrackingParam(name: string): boolean {
  const k = name.toLowerCase()
  if (TRACKING_EXACT.has(k)) return true
  return TRACKING_PREFIX.some((p) => k.startsWith(p))
}

export function isHttpUrl(u: string | URL | undefined | null): boolean {
  if (!u) return false
  try {
    const url = typeof u === 'string' ? new URL(u) : u
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Lowercase scheme/host, drop fragment and default port, drop tracking params,
 *  sort the remaining query keys. Returns undefined for non-http(s) or garbage. */
export function normalizeUrl(input: string | URL): string | undefined {
  let url: URL
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = ''
  }
  url.username = ''
  url.password = ''
  const kept: [string, string][] = []
  for (const [k, v] of url.searchParams) if (!isTrackingParam(k)) kept.push([k, v])
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  url.search = ''
  if (kept.length) {
    const sp = new URLSearchParams()
    for (const [k, v] of kept) sp.append(k, v)
    url.search = sp.toString()
  }
  return url.href
}

/** Suffix match on registrable-ish host: `news.example.com` matches `example.com`
 *  and `news.example.com`, never `notexample.com`. */
export function hostMatches(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return allowed.some((a) => {
    const al = a.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
    return h === al || h.endsWith('.' + al)
  })
}

/** Resolve `href` against `base`; undefined when unparsable or non-http. */
export function resolveHttp(href: string | undefined | null, base: string | URL): string | undefined {
  if (!href) return undefined
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed.startsWith('blob:')) return undefined
  try {
    const u = new URL(trimmed, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return u.href
  } catch {
    return undefined
  }
}
