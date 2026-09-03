// Dates in article args are strings, `YYYY-MM-DD`. The publisher's own literal
// date wins when the input already starts with one (no timezone shift — a story
// dated 2026-09-03 in Nairobi stays 2026-09-03 even if that was 2026-09-02 in
// UTC). Anything else goes through Date.parse and is reported in UTC.

const ISO_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/
const MIN_YEAR = 1990
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT|[ECMP][SD]T)\b)\s*$/i

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function validYmd(y: number, m: number, d: number, now: Date): boolean {
  if (y < MIN_YEAR || y > now.getUTCFullYear() + 1) return false
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

/** Normalise any date-ish string to `YYYY-MM-DD`, or undefined if unusable. */
export function toIsoDate(input: string | undefined | null, now: Date = new Date()): string | undefined {
  if (!input) return undefined
  const s = input.trim()
  if (!s) return undefined
  const m = ISO_PREFIX.exec(s)
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
    if (validYmd(y, mo, d, now)) return `${m[1]}-${m[2]}-${m[3]}`
    return undefined
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) return undefined
  const dt = new Date(t)
  // A string with an explicit zone is a real instant: report its UTC date. A
  // zone-less string ("September 3, 2026") was parsed as LOCAL time, so read
  // local components back to recover the literal date the publisher wrote.
  const zoned = HAS_ZONE.test(s)
  const y = zoned ? dt.getUTCFullYear() : dt.getFullYear()
  const mo = (zoned ? dt.getUTCMonth() : dt.getMonth()) + 1
  const d = zoned ? dt.getUTCDate() : dt.getDate()
  if (!validYmd(y, mo, d, now)) return undefined
  return `${y}-${pad2(mo)}-${pad2(d)}`
}

/** Today's date in the machine's local timezone — "when YOU captured it". */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Compare two ISO date/time strings loosely; returns true if `a` is after `b`. */
export function isAfter(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const ta = Date.parse(a), tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false
  return ta > tb
}
