// Text normalisation shared by extraction and flattening. Souspli renders block text
// via textContent with no white-space CSS, so newlines collapse anyway; we
// normalise up front so hashes and byte budgets are stable.

const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g
const NBSP = /[\u00A0\u202F]/g
const WS = /\s+/g

/** NFC, strip zero-width characters, NBSP→space, collapse whitespace, trim. */
export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(ZERO_WIDTH, '').replace(NBSP, ' ').replace(WS, ' ').trim()
}

/** Like normalizeText but keeps line breaks (for code and pre blocks). */
export function normalizeLines(s: string): string {
  return s
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(NBSP, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function isBlank(s: string | undefined | null): boolean {
  return s === undefined || s === null || normalizeText(s).length === 0
}

/** Trim to at most `max` characters on a word boundary, appending an ellipsis. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max / 2 ? cut.slice(0, sp) : cut) + '…'
}

/** Case-insensitive de-duplication preserving first occurrence and order. */
export function dedupeCi(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const item = normalizeText(raw)
    if (!item) continue
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•', times: '×', shy: ''
}

/** Decode the HTML entities that show up in feed titles and meta content. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m
      try {
        return String.fromCodePoint(code)
      } catch {
        return m
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named !== undefined ? named : m
  })
}
