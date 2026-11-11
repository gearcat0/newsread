// What a subscriber can ask for, and what it does to the list.
//
// A request is an ordinary memo, sealed to the bot. Its subject (or, failing
// that, the first non-empty line of its message) is one of:
//
//   subscribe all | subscribe <site> [<site>…]
//   unsubscribe all | unsubscribe <site> [<site>…]
//   list
//
// Case and commas don't matter. The latest letter per author wins, the way a
// vote does: one written earlier never undoes one written later, whatever
// order the relay delivers them in.
import type { SiteChoice, Subscriber } from './state.js'

export type Request =
  | { action: 'subscribe' | 'unsubscribe'; sites: SiteChoice }
  | { action: 'list' }

export function parseRequestLine(line: string): Request | null {
  const words = line
    .toLowerCase()
    .replace(/[,;]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const [verb, ...rest] = words
  if (verb === 'list' && rest.length === 0) return { action: 'list' }
  if (verb !== 'subscribe' && verb !== 'unsubscribe') return null
  if (rest.length === 0 || rest.includes('all')) return { action: verb, sites: 'all' }
  return { action: verb, sites: [...new Set(rest)] }
}

export function parseRequest(subject: string | undefined, message: string | undefined): Request | null {
  const fromSubject = subject ? parseRequestLine(subject.replace(/^(re|fwd?):\s*/i, '')) : null
  if (fromSubject) return fromSubject
  const first = (message ?? '').split('\n').find((l) => l.trim())
  return first ? parseRequestLine(first) : null
}

export interface Applied {
  /** the subscriber after the change; undefined = no longer subscribed */
  next: Subscriber | undefined
  /** requested ids that are not configured sites */
  unknown: string[]
}

/** Apply a subscribe/unsubscribe to one subscriber's record. Pure. */
export function applyRequest(
  current: Subscriber | undefined,
  req: Extract<Request, { action: 'subscribe' | 'unsubscribe' }>,
  known: string[],
  meta: { ek: string; created: number; envelopeHash: string }
): Applied {
  const unknown = req.sites === 'all' ? [] : req.sites.filter((s) => !known.includes(s))
  const asked = req.sites === 'all' ? 'all' : req.sites.filter((s) => known.includes(s))
  const stamp = { ek: meta.ek, updated: meta.created, lastRequest: meta.envelopeHash }
  if (req.action === 'subscribe') {
    if (asked !== 'all' && asked.length === 0) return { next: current, unknown }
    const sites: SiteChoice = asked === 'all' || current?.sites === 'all' ? 'all' : [...new Set([...(current?.sites ?? []), ...asked])].sort()
    return { next: { ...stamp, sites }, unknown }
  }
  if (!current || asked === 'all') return { next: undefined, unknown }
  const have = current.sites === 'all' ? known : current.sites
  const left = have.filter((s) => !asked.includes(s))
  return { next: left.length ? { ...stamp, sites: left.sort() } : undefined, unknown }
}

/** Every configured site at least one subscriber wants. */
export function wantedSites(subscribers: Record<string, Subscriber>, known: string[]): Set<string> {
  const out = new Set<string>()
  for (const s of Object.values(subscribers)) for (const id of s.sites === 'all' ? known : s.sites) if (known.includes(id)) out.add(id)
  return out
}

export function describeSites(sites: SiteChoice | undefined): string {
  if (!sites) return 'nothing'
  return sites === 'all' ? 'every site' : sites.join(', ')
}
