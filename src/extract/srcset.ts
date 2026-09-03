// Image candidate discovery. News sites lazy-load aggressively: the real image
// is often in srcset / data-src / <picture><source>, and `src` is a 1x1 gif.
import { resolveHttp } from '../util/url.js'

export interface ImageCandidate {
  url: string
  /** Intrinsic width from a `w` descriptor or width attribute. */
  width?: number
  /** Pixel density from an `x` descriptor. */
  density?: number
}

/** Parse a srcset attribute per the HTML spec's tokenizer: URLs may contain
 *  commas (Cloudinary-style paths), so a comma only ends a candidate when it
 *  trails the URL or follows the descriptors. */
export function parseSrcset(srcset: string, base?: string | URL): ImageCandidate[] {
  const out: ImageCandidate[] = []
  const s = srcset
  let i = 0
  const n = s.length
  while (i < n) {
    while (i < n && (/\s/.test(s[i]!) || s[i] === ',')) i++
    if (i >= n) break
    let start = i
    while (i < n && !/\s/.test(s[i]!)) i++
    let url = s.slice(start, i)
    let descriptors = ''
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '')
    } else {
      // collect descriptors up to the next top-level comma
      start = i
      let depth = 0
      while (i < n) {
        const c = s[i]!
        if (c === '(') depth++
        else if (c === ')') depth = Math.max(0, depth - 1)
        else if (c === ',' && depth === 0) break
        i++
      }
      descriptors = s.slice(start, i)
      i++ // skip the comma
    }
    if (!url) continue
    const resolved = base ? resolveHttp(url, base) : url
    if (!resolved) continue
    const cand: ImageCandidate = { url: resolved }
    for (const d of descriptors.trim().split(/\s+/).filter(Boolean)) {
      const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(d)
      if (!m) continue
      const v = Number(m[1])
      if (!Number.isFinite(v) || v <= 0) continue
      if (m[2]!.toLowerCase() === 'w') cand.width = Math.round(v)
      else cand.density = v
    }
    out.push(cand)
  }
  return out
}

const LAZY_SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset', 'data-src-set']
const LAZY_SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-hi-res-src', 'data-full-src', 'src']

function attrNumber(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name)
  if (!raw) return undefined
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/** All plausible source URLs for an <img>, largest-first where known. Walks a
 *  wrapping <picture> for <source srcset>. Placeholder data: URLs are skipped. */
export function imageCandidates(img: Element, base: string | URL): ImageCandidate[] {
  const seen = new Map<string, ImageCandidate>()
  const add = (c: ImageCandidate): void => {
    const prev = seen.get(c.url)
    if (!prev) seen.set(c.url, c)
    else {
      if (c.width && (!prev.width || c.width > prev.width)) prev.width = c.width
      if (c.density && (!prev.density || c.density > prev.density)) prev.density = c.density
    }
  }
  const picture = img.parentElement?.tagName?.toLowerCase() === 'picture' ? img.parentElement : null
  if (picture) {
    for (const source of Array.from(picture.querySelectorAll('source'))) {
      const type = source.getAttribute('type') ?? ''
      if (type && !/^image\//i.test(type)) continue
      for (const a of LAZY_SRCSET_ATTRS) {
        const v = source.getAttribute(a)
        if (v) for (const c of parseSrcset(v, base)) add(c)
      }
    }
  }
  for (const a of LAZY_SRCSET_ATTRS) {
    const v = img.getAttribute(a)
    if (v) for (const c of parseSrcset(v, base)) add(c)
  }
  const width = attrNumber(img, 'width') ?? attrNumber(img, 'data-width')
  for (const a of LAZY_SRC_ATTRS) {
    const v = img.getAttribute(a)
    const url = resolveHttp(v, base)
    if (url) add({ url, ...(width ? { width } : {}) })
  }
  return Array.from(seen.values())
}

/** Largest `w`, else highest `x`, else the first candidate. */
export function pickCandidate(cands: readonly ImageCandidate[]): ImageCandidate | undefined {
  if (!cands.length) return undefined
  let best: ImageCandidate | undefined
  for (const c of cands) {
    if (!best) {
      best = c
      continue
    }
    const bw = best.width ?? 0, cw = c.width ?? 0
    if (cw !== bw) {
      if (cw > bw) best = c
      continue
    }
    const bd = best.density ?? 0, cd = c.density ?? 0
    if (cd > bd) best = c
  }
  return best
}
