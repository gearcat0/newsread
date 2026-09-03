// Download the images (and optionally videos) an article references, sniff
// their real MIME, de-duplicate by content hash, and hand out cage attachment
// names in document order. Failures drop the figure rather than leaving a
// permanent "image not attached" placeholder.
import type { ImagePolicy, MediaConfig } from './config.js'
import type { HttpClient } from './http.js'
import type { IrBlock, IrDocument, IrImage } from './ir.js'
import type { ImageCandidate } from './extract/srcset.js'
import { isImageMime, isVideoMime, sniffMime } from './sniff.js'
import { hash, toHex } from './cage.js'
import { hostMatches } from './util/url.js'
import { mapLimit } from './util/limiter.js'

export interface ResolvedMedia {
  name: string
  bytes: Uint8Array
  mime: string
  sha256: string
  url: string
}

export interface MediaFailure {
  url: string
  reason: string
}

export interface MediaResolution {
  /** Figure/video IR blocks (by identity) that resolved to an attachment. */
  byBlock: Map<IrBlock, ResolvedMedia>
  /** Metadata lead image, when policy asked for it and it resolved. */
  lead?: ResolvedMedia
  failed: MediaFailure[]
  skipped: MediaFailure[]
}

export interface MediaOptions {
  media: MediaConfig
  policy: ImagePolicy
}

const DEFAULT_SKIP = /(pixel|tracker|beacon|spacer|1x1|avatar|logo|icon|badge|sprite|emoji|share|button)/i
const DEFAULT_MIN_WIDTH = 200

function walk(blocks: readonly IrBlock[], visit: (b: IrBlock) => void): void {
  for (const b of blocks) {
    visit(b)
    if (b.kind === 'list') for (const item of b.items) walk(item, visit)
    else if (b.kind === 'blockquote') walk(b.children, visit)
  }
}

/** Candidates worth trying, best first, after policy filtering. */
export function eligibleCandidates(image: IrImage, policy: ImagePolicy): { tried: ImageCandidate[]; skipped: MediaFailure[] } {
  const skip = policy.skipPatterns ?? [DEFAULT_SKIP]
  const minWidth = policy.minWidth ?? DEFAULT_MIN_WIDTH
  const skipped: MediaFailure[] = []
  const ok: ImageCandidate[] = []
  for (const c of image.candidates) {
    if (/\.svgz?(?:[?#]|$)/i.test(c.url)) {
      skipped.push({ url: c.url, reason: 'svg' })
      continue
    }
    if (skip.some((re) => re.test(c.url))) {
      skipped.push({ url: c.url, reason: 'skip pattern' })
      continue
    }
    if (policy.allowHosts?.length && !hostMatches(new URL(c.url).hostname, policy.allowHosts)) {
      skipped.push({ url: c.url, reason: 'host not allowed' })
      continue
    }
    const w = c.width ?? (image.candidates.length === 1 ? image.width : undefined)
    if (w !== undefined && w < minWidth) {
      skipped.push({ url: c.url, reason: `width ${w} < ${minWidth}` })
      continue
    }
    ok.push(c)
  }
  ok.sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.density ?? 0) - (a.density ?? 0))
  return { tried: ok.slice(0, 3), skipped }
}

interface Fetched {
  bytes: Uint8Array
  mime: string
  sha256: string
  url: string
}

async function fetchOne(http: HttpClient, url: string, maxBytes: number, accept: string, want: (m: string | undefined) => m is string): Promise<Fetched | MediaFailure> {
  let res
  try {
    res = await http.get(url, { accept, maxBytes })
  } catch (e) {
    return { url, reason: (e as Error).message }
  }
  if (res.status < 200 || res.status >= 300) return { url, reason: `HTTP ${res.status}` }
  const mime = sniffMime(res.body)
  if (!want(mime)) return { url, reason: `not an accepted type (sniffed ${mime ?? 'unknown'})` }
  return { bytes: res.body, mime, sha256: toHex(hash(res.body)), url }
}

async function fetchFirst(http: HttpClient, cands: ImageCandidate[], maxBytes: number): Promise<{ fetched?: Fetched; failures: MediaFailure[] }> {
  const failures: MediaFailure[] = []
  for (const c of cands) {
    const r = await fetchOne(http, c.url, maxBytes, 'image/avif,image/webp,image/*,*/*;q=0.8', isImageMime)
    if ('bytes' in r) return { fetched: r, failures }
    failures.push(r)
  }
  return { failures }
}

export async function resolveMedia(ir: IrDocument, http: HttpClient, opts: MediaOptions): Promise<MediaResolution> {
  const { media, policy } = opts
  const result: MediaResolution = { byBlock: new Map(), failed: [], skipped: [] }

  const figures: { block: IrBlock; image: IrImage }[] = []
  const videos: IrBlock[] = []
  walk(ir.blocks, (b) => {
    if (b.kind === 'figure') figures.push({ block: b, image: b.image })
    else if (b.kind === 'video' && media.video) videos.push(b)
  })

  const leadMode = policy.leadImage ?? 'auto'
  const wantLead = !!ir.meta.leadImage && (leadMode === 'always' || (leadMode === 'auto' && figures.length === 0))

  // Download every figure (bounded concurrency; the http client serialises per host).
  const jobs: { image: IrImage; block?: IrBlock }[] = []
  if (wantLead) jobs.push({ image: ir.meta.leadImage! })
  for (const f of figures) jobs.push({ image: f.image, block: f.block })

  const fetched = await mapLimit(jobs, Math.max(1, media.concurrency), async (job) => {
    const { tried, skipped } = eligibleCandidates(job.image, policy)
    result.skipped.push(...skipped)
    if (!tried.length) return undefined
    const { fetched, failures } = await fetchFirst(http, tried, media.maxImageBytes)
    result.failed.push(...failures)
    return fetched
  })

  // Assign names in document order (lead first), de-duplicating by hash and
  // enforcing the count and byte budgets.
  const seen = new Map<string, ResolvedMedia>()
  let total = 0
  let imgN = 0
  for (let i = 0; i < jobs.length; i++) {
    const f = fetched[i]
    const job = jobs[i]!
    if (!f) continue
    if (seen.has(f.sha256)) {
      // Same bytes already attached (e.g. lead image repeated in the body). If
      // the earlier copy is the lead and this one is a real figure, prefer the
      // figure so its caption survives, and drop the lead.
      const prev = seen.get(f.sha256)!
      if (!job.block) continue
      if (result.lead === prev) {
        result.lead = undefined
        result.byBlock.set(job.block, prev)
      }
      continue
    }
    if (imgN >= media.maxImages) {
      result.skipped.push({ url: f.url, reason: `more than ${media.maxImages} images` })
      continue
    }
    if (total + f.bytes.length > media.maxTotalBytes) {
      result.skipped.push({ url: f.url, reason: 'total media budget exceeded' })
      continue
    }
    imgN++
    total += f.bytes.length
    const resolved: ResolvedMedia = { name: `img-${imgN}`, ...f }
    seen.set(f.sha256, resolved)
    if (job.block) result.byBlock.set(job.block, resolved)
    else result.lead = resolved
  }

  // Videos: direct files only, sniffed, under their own cap.
  let vidN = 0
  for (const v of videos) {
    if (v.kind !== 'video') continue
    const cands = v.sources.filter((s) => !s.mime || /^video\/(mp4|webm)/i.test(s.mime)).filter((s) => !/\.m3u8|\.mpd(?:[?#]|$)/i.test(s.url))
    let got: Fetched | undefined
    for (const s of cands.slice(0, 2)) {
      const r = await fetchOne(http, s.url, media.maxVideoBytes, 'video/*,*/*;q=0.8', isVideoMime)
      if ('bytes' in r) {
        got = r
        break
      }
      result.failed.push(r)
    }
    if (!got) continue
    if (total + got.bytes.length > media.maxTotalBytes) {
      result.skipped.push({ url: got.url, reason: 'total media budget exceeded' })
      continue
    }
    total += got.bytes.length
    vidN++
    result.byBlock.set(v, { name: `vid-${vidN}`, ...got })
  }

  return result
}
