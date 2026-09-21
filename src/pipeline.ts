// One story, end to end: fetch → extract → IR → media → flatten → build+sign →
// self-verify → write → record. `runSite` drives it from feed discovery.
import { type Config, type Site, expandPath } from './config.js'
import type { HttpClient } from './http.js'
import { decodeHtml } from './http.js'
import type { Signer } from './souspli.js'
import type { ArticleMeta, IrDocument } from './ir.js'
import { baseUrlOf, parseHtml, removeAll } from './extract/dom.js'
import { type BodyResult, domToIr, extractBody } from './extract/body.js'
import { applyDateline, extractMeta } from './extract/metadata.js'
import { resolveMedia } from './media.js'
import { flatten } from './flatten.js'
import { buildArticle, contentHash, type Chain } from './bundle.js'
import { StateStore, storyPath } from './state.js'
import { writeOutputs } from './output.js'
import { type Discoverer, FeedDiscoverer } from './discover.js'
import { normalizeUrl } from './util/url.js'
import { isAfter, localIsoDate } from './util/dates.js'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  debug(msg: string): void
}

export interface Flags {
  dryRun: boolean
  debug: boolean
  refresh: boolean
}

export interface Ctx {
  config: Config
  http: HttpClient
  state: StateStore
  signer: Signer
  now: () => Date
  log: Logger
  flags: Flags
  discoverer?: Discoverer
}

export type Outcome =
  | { kind: 'emitted'; url: string; outFile: string; seq: number; title?: string; dryRun: boolean; warnings: string[] }
  | { kind: 'unchanged'; url: string }
  | { kind: 'skipped'; url: string; reason: string }
  | { kind: 'failed'; url: string; error: string }

export interface FeedHint {
  title?: string
  published?: string
  updated?: string
}

interface Page {
  doc: Document
  fetchedUrl: string
  body: BodyResult | undefined
  meta: ArticleMeta
}

async function loadPage(url: string, site: Site, ctx: Ctx, hint: FeedHint | undefined): Promise<Page | { error: string }> {
  const cfg = ctx.config
  const res = await ctx.http.get(url, { maxBytes: cfg.maxHtmlBytes, ...(site.fetch?.headers ? { headers: site.fetch.headers } : {}) })
  if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` }
  const ct = res.headers.get('content-type') ?? ''
  if (ct && !/html|xml/i.test(ct)) return { error: `not an HTML page (${ct})` }
  const doc = parseHtml(decodeHtml(res.body, ct), res.url)
  if (site.removeSelectors?.length) removeAll(doc, site.removeSelectors)
  site.prepare?.(doc, new URL(res.url))
  const body = extractBody(doc, site, res.url)
  const meta = extractMeta(doc, {
    site,
    fetchedUrl: res.url,
    now: ctx.now(),
    ...(hint ? { feed: hint } : {}),
    ...(body?.readability ? { readability: body.readability } : {})
  })
  return { doc, fetchedUrl: res.url, body, meta }
}

export async function processUrl(url: string, site: Site, ctx: Ctx, hint?: FeedHint): Promise<Outcome> {
  const cfg = ctx.config
  const start = normalizeUrl(url) ?? url
  try {
    let page = await loadPage(start, site, ctx, hint)
    if ('error' in page) return { kind: 'failed', url: start, error: page.error }

    // One hop to the canonical URL (AMP copies, syndication, tracking paths).
    const fetchedNorm = normalizeUrl(page.fetchedUrl) ?? page.fetchedUrl
    if (site.followCanonical !== false && page.meta.canonicalUrl !== fetchedNorm) {
      ctx.log.debug(`canonical ${page.meta.canonicalUrl} differs from ${fetchedNorm}; refetching`)
      const second = await loadPage(page.meta.canonicalUrl, site, ctx, hint)
      if (!('error' in second) && second.body && second.body.textLength >= cfg.limits.minBodyChars) page = second
      else ctx.log.warn(`canonical refetch unusable (${'error' in second ? second.error : 'no body'}); keeping the fetched page`)
    }

    const { doc, body, meta } = page
    const canonical = meta.canonicalUrl
    if (!body || body.textLength < cfg.limits.minBodyChars) {
      return { kind: 'skipped', url: canonical, reason: `no article body (${body?.textLength ?? 0} chars)` }
    }
    const { blocks, warnings } = domToIr(body.root, baseUrlOf(doc, page.fetchedUrl))
    const ir: IrDocument = { meta, blocks, warnings }
    applyDateline(ir)
    if (!ir.blocks.length) return { kind: 'skipped', url: canonical, reason: 'empty body after extraction' }

    const media = await resolveMedia(ir, ctx.http, { media: cfg.media, policy: site.imagePolicy ?? {} })
    const flat = flatten(ir, media, { limits: cfg.limits, retrieved: localIsoDate(ctx.now()) })
    const allWarnings = [...flat.warnings, ...media.failed.map((f) => `media failed: ${f.url} (${f.reason})`)]

    const prev = ctx.state.getStory(canonical)
    const ch = contentHash(flat.args, flat.attachments)
    const nowIso = ctx.now().toISOString()
    if (prev && prev.contentHash === ch) {
      if (!ctx.flags.dryRun) {
        ctx.state.setStory(canonical, { ...prev, lastFetched: nowIso })
        ctx.state.setAlias(start, canonical)
        ctx.state.save()
      }
      return { kind: 'unchanged', url: canonical }
    }

    const chain: Chain = prev ? { path: prev.path, seq: prev.seq + 1, prev: prev.envelopeHash } : { path: storyPath(canonical), seq: 1 }
    const created = Math.floor(ctx.now().getTime() / 1000)
    const built = await buildArticle(ctx.signer, flat.args, flat.attachments, chain, created, cfg.limits.hardArgsBytes)

    const title = flat.args.title
    if (ctx.flags.dryRun) {
      return { kind: 'emitted', url: canonical, outFile: '', seq: chain.seq, ...(title ? { title } : {}), dryRun: true, warnings: allWarnings }
    }
    const outFile = writeOutputs({
      outDir: expandPath(cfg.outDir),
      siteId: site.id,
      args: flat.args,
      tar: built.tar,
      envelopeHash: built.envelopeHash,
      ...(ctx.flags.debug ? { debug: { ir, media: { failed: media.failed, skipped: media.skipped }, warnings: allWarnings } } : {})
    })
    ctx.state.setStory(canonical, {
      siteId: site.id,
      path: chain.path,
      seq: chain.seq,
      envelopeHash: built.envelopeHash,
      manifestHash: built.manifestHash,
      contentHash: ch,
      firstSeen: prev?.firstSeen ?? nowIso,
      lastFetched: nowIso,
      lastEmitted: nowIso,
      outFile,
      ...(title ? { title } : {})
    })
    ctx.state.setAlias(start, canonical)
    ctx.state.setAlias(fetchedNorm, canonical)
    ctx.state.save()
    return { kind: 'emitted', url: canonical, outFile, seq: chain.seq, ...(title ? { title } : {}), dryRun: false, warnings: allWarnings }
  } catch (e) {
    return { kind: 'failed', url: start, error: (e as Error).message }
  }
}

export interface RunOptions {
  limit?: number
}

export async function runSite(site: Site, ctx: Ctx, opts: RunOptions = {}): Promise<Outcome[]> {
  const discoverer = ctx.discoverer ?? new FeedDiscoverer()
  // --refresh must see every item again, so skip the conditional GET (a 304
  // would hide the whole feed) while still recording the new validators.
  const feedState = ctx.flags.refresh ? { get: () => undefined, set: ctx.state.feedState.set } : ctx.state.feedState
  const found = await discoverer.discover(site, {
    http: ctx.http,
    feedState,
    now: ctx.now,
    log: (m) => ctx.log.warn(`[${site.id}] ${m}`)
  })
  if (!ctx.flags.dryRun) ctx.state.save()
  ctx.log.info(`[${site.id}] ${found.length} item${found.length === 1 ? '' : 's'} in feeds`)
  const outcomes: Outcome[] = []
  const limit = opts.limit ?? site.maxPerRun ?? Number.POSITIVE_INFINITY
  let processed = 0
  for (const d of found) {
    if (processed >= limit) break
    const prev = ctx.state.getStory(d.url)
    if (prev && !ctx.flags.refresh && !isAfter(d.updated, prev.lastFetched)) {
      outcomes.push({ kind: 'skipped', url: d.url, reason: 'already archived' })
      continue
    }
    processed++
    const hint: FeedHint = {}
    if (d.title) hint.title = d.title
    if (d.published) hint.published = d.published
    if (d.updated) hint.updated = d.updated
    const o = await processUrl(d.url, site, ctx, hint)
    outcomes.push(o)
    ctx.log.info(`[${site.id}] ${describe(o)}`)
  }
  return outcomes
}

export function describe(o: Outcome): string {
  switch (o.kind) {
    case 'emitted':
      return `${o.dryRun ? 'would emit' : 'emitted'} v${o.seq} ${o.title ? JSON.stringify(o.title) : o.url}${o.outFile ? ` → ${o.outFile}` : ''}${o.warnings.length ? ` (${o.warnings.length} warning${o.warnings.length === 1 ? '' : 's'})` : ''}`
    case 'unchanged':
      return `unchanged ${o.url}`
    case 'skipped':
      return `skipped ${o.url}: ${o.reason}`
    case 'failed':
      return `FAILED ${o.url}: ${o.error}`
  }
}
