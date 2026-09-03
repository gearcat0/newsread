import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { processUrl, runSite, type Ctx, type Outcome } from '../src/pipeline.js'
import { defineConfig, type Site } from '../src/config.js'
import { StateStore, storyPath } from '../src/state.js'
import { ethSigner } from '../src/identity.js'
import { admitBundle, parseBundle, cborToJs, programHashHex, toHex, chainInfo } from '../src/cage.js'
import { inspectBundle } from '../src/bundle.js'
import { verifyDirectory, listThings } from '../src/cli.js'
import { fakeHttp, type FakeRoutes } from './helpers/fakeHttp.js'
import * as img from './helpers/images.js'
import type { ArticleArgs } from '../src/args.js'

const fx = (n: string): string => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')
const URL_FEED = 'https://www.example.com/local/scaffolding-monday?utm_source=feed'
const CANON = 'https://www.example.com/local/scaffolding-monday'
const tmp = (): string => mkdtempSync(join(process.env['NEWSREAD_TEST_TMP'] ?? tmpdir(), 'newsread-pipe-'))

const site: Site = { id: 'ex', publisher: 'The Example Times', hosts: ['example.com'], feeds: ['https://www.example.com/feed.xml'] }

function routes(html = fx('pages/rich.html')): FakeRoutes {
  return {
    [URL_FEED]: { body: html, headers: { 'content-type': 'text/html; charset=utf-8' }, finalUrl: URL_FEED },
    [CANON]: { body: html, headers: { 'content-type': 'text/html; charset=utf-8' } },
    'https://www.example.com/img/face-1600.webp': { body: img.webp(1) },
    'https://www.example.com/img/face-800.webp': { body: img.webp(2) },
    'https://www.example.com/img/face-800.jpg': { body: img.jpeg(3) },
    'https://www.example.com/img/face-400.jpg': { body: img.jpeg(4) },
    'https://www.example.com/img/pixel.gif': { body: img.gif(5) },
    'https://cdn.example.com/lead-1200.jpg': { body: img.jpeg(6) }
  }
}

function makeCtx(r: FakeRoutes, dir: string, over: Partial<Ctx> = {}): Ctx {
  const config = defineConfig({ outDir: join(dir, 'out'), stateFile: join(dir, 'state.json'), perHostDelayMs: 0, sites: [site] })
  const logs: string[] = []
  return {
    config,
    http: fakeHttp(r),
    state: StateStore.load(config.stateFile),
    signer: ethSigner(secp256k1.utils.randomSecretKey()),
    now: () => new Date('2026-09-04T10:00:00Z'),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push('warn ' + m), debug: () => undefined },
    flags: { dryRun: false, debug: true, refresh: false },
    ...over
  }
}

describe('processUrl end to end', () => {
  it('emits a valid article thing with metadata, blocks and image attachments', async () => {
    const dir = tmp()
    const ctx = makeCtx(routes(), dir)
    const o = await processUrl(URL_FEED, site, ctx)
    expect(o.kind).toBe('emitted')
    if (o.kind !== 'emitted') return
    expect(o.seq).toBe(1)
    expect(o.url).toBe(CANON)
    expect(o.outFile).toMatch(/\/out\/ex\/2026-09-03-scaffolding-goes-up-on-monday-[0-9a-f]{8}\.thing$/)
    expect(existsSync(o.outFile)).toBe(true)
    expect(existsSync(o.outFile.replace(/\.thing$/, '.args.json'))).toBe(true)

    const r = admitBundle(parseBundle(new Uint8Array(readFileSync(o.outFile))))
    expect(r.status).toBe('valid')
    if (r.status !== 'valid') return
    expect(r.manifest.type).toBe('article')
    expect(toHex(r.manifest.prog)).toBe(programHashHex())
    expect(r.envelope.author.s).toBe('eth-eip191')
    expect(r.envelope.path).toBe(storyPath(CANON))
    expect(r.envelope.seq).toBe(1)
    expect(r.envelope.created).toBe(Math.floor(Date.parse('2026-09-04T10:00:00Z') / 1000))
    expect(r.manifestBytes.length).toBeLessThan(256 * 1024)

    const args = cborToJs(r.manifest.args) as ArticleArgs
    expect(args.title).toBe('Scaffolding goes up on Monday')
    expect(args.deck).toBe('Works begin at the north face')
    expect(args.authors).toEqual(['A. Reporter', 'B. Photographer'])
    expect(args.publisher).toBe('The Example Times')
    expect(args.section).toBe('Local')
    expect(args.location).toBe('Nairobi')
    expect(args.published).toBe('2026-09-03')
    expect(args.updated).toBe('2026-09-04')
    expect(args.retrieved).toBe('2026-09-04')
    expect(args.sourceUrl).toBe(CANON)
    expect(args.language).toBe('en')
    expect(args.rights).toBe('© 2026 The Example Times Ltd')
    expect(args.keywords).toEqual(['works', 'roof'])
    expect(args.byline).toBeUndefined()
    for (const [k, v] of Object.entries(args)) {
      if (k === 'blocks') continue
      if (Array.isArray(v)) v.forEach((x) => expect(typeof x).toBe('string'))
      else expect(typeof v).toBe('string')
    }
    const kinds = args.blocks.map((b) => b.kind)
    expect(kinds).not.toContain('heading:title')
    expect(args.blocks.find((b) => b.kind === 'heading' && b.text === 'What is happening')).toBeTruthy()
    expect(args.blocks.find((b) => b.kind === 'subheading' && b.text === 'The detail')).toBeTruthy()
    expect(args.blocks.some((b) => b.kind === 'paragraph' && b.text.startsWith('• Stone survey'))).toBe(true)
    expect(args.blocks.some((b) => b.kind === 'paragraph' && b.text.startsWith('3. Third item'))).toBe(true)
    expect(args.blocks.some((b) => b.kind === 'paragraph' && b.text.startsWith('“The scaffold will remain'))).toBe(true)
    expect(args.blocks.some((b) => b.kind === 'paragraph' && b.text === 'Phase | Start')).toBe(true)
    expect(args.blocks.some((b) => b.kind === 'footnote' && b.text.startsWith('Video not captured'))).toBe(true)
    expect(args.blocks.some((b) => b.kind === 'footnote' && b.text.startsWith('Embedded content omitted: https://www.youtube.com/embed/abc123'))).toBe(true)
    // the dateline moved into `location`, not left in the paragraph; links dropped
    const first = args.blocks.find((b) => b.kind === 'paragraph')!
    expect(first.kind === 'paragraph' && first.text.startsWith('Contractors arrive at first light')).toBe(true)
    expect(JSON.stringify(args)).not.toContain('/statement')
    expect(JSON.stringify(args)).not.toContain('<')

    const images = args.blocks.filter((b) => b.kind === 'image')
    expect(images.length).toBe(1)
    expect(images[0]).toEqual({ kind: 'image', name: 'img-1', caption: 'The north face on Friday (Photo: B. Photographer)', alt: 'Scaffolding on the north face', placement: 'full' })
    expect(r.manifest.att.get('img-1')?.m).toBe('image/webp')
    expect(r.attachments.get('img-1')).toEqual(img.webp(1))
    expect(r.manifest.att.size).toBe(1)

    // state recorded under the canonical URL with the discovered URL as alias
    const rec = ctx.state.getStory(CANON)!
    expect(rec.seq).toBe(1)
    expect(rec.envelopeHash).toBe(toHex(r.envelopeHash))
    expect(rec.outFile).toBe(o.outFile)
    expect(ctx.state.getStory('https://www.example.com/local/scaffolding-monday')).toBe(rec)
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).stories[CANON].seq).toBe(1)

    // verify passes
    const v = verifyDirectory(join(dir, 'out'))
    expect(v.length).toBe(1)
    expect(v[0]!.ok).toBe(true)
    expect(v[0]!.problems).toEqual([])
    const insp = inspectBundle(new Uint8Array(readFileSync(o.outFile)))
    expect(insp.programMatches).toBe(true)
    expect(insp.author?.display).toMatch(/^0x/)
  })

  it('re-running unchanged content emits nothing; changed content becomes the next version in the chain', async () => {
    const dir = tmp()
    const ctx = makeCtx(routes(), dir)
    const first = await processUrl(URL_FEED, site, ctx)
    expect(first.kind).toBe('emitted')
    const again = await processUrl(URL_FEED, site, { ...ctx, now: () => new Date('2026-09-05T10:00:00Z') })
    expect(again).toEqual({ kind: 'unchanged', url: CANON })
    expect(listThings(join(dir, 'out')).length).toBe(1)

    const edited = fx('pages/rich.html').replace('Contractors arrive at first light on Monday', 'Contractors arrived at first light on Tuesday')
    const ctx2 = { ...ctx, http: fakeHttp(routes(edited)), now: () => new Date('2026-09-06T10:00:00Z') }
    const second = await processUrl(URL_FEED, site, ctx2)
    expect(second.kind).toBe('emitted')
    if (second.kind !== 'emitted' || first.kind !== 'emitted') return
    expect(second.seq).toBe(2)
    expect(listThings(join(dir, 'out')).length).toBe(2)
    const r1 = admitBundle(parseBundle(new Uint8Array(readFileSync(first.outFile))))
    const r2 = admitBundle(parseBundle(new Uint8Array(readFileSync(second.outFile))))
    if (r1.status !== 'valid' || r2.status !== 'valid') throw new Error('not valid')
    const c2 = chainInfo(r2.envelope)
    expect(c2.path).toBe(storyPath(CANON))
    expect(c2.seq).toBe(2)
    expect(toHex(c2.prev!)).toBe(toHex(r1.envelopeHash))
    expect(ctx.state.getStory(CANON)!.seq).toBe(2)
    expect(ctx.state.getStory(CANON)!.firstSeen).toBe('2026-09-04T10:00:00.000Z')
    expect(verifyDirectory(join(dir, 'out')).every((v) => v.ok)).toBe(true)
  })

  it('dry-run builds but writes nothing and records nothing', async () => {
    const dir = tmp()
    const ctx = makeCtx(routes(), dir, { flags: { dryRun: true, debug: false, refresh: false } })
    const o = await processUrl(URL_FEED, site, ctx)
    expect(o.kind).toBe('emitted')
    if (o.kind !== 'emitted') return
    expect(o.dryRun).toBe(true)
    expect(existsSync(join(dir, 'out'))).toBe(false)
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
    expect(ctx.state.storyCount).toBe(0)
  })

  it('follows the canonical link once (AMP → full page) and skips pages with no body', async () => {
    const dir = tmp()
    const AMP = 'https://amp.example.com/local/full-story/amp'
    const FULL = 'https://www.example.com/local/full-story'
    const r = routes()
    r[AMP] = { body: fx('pages/amp.html') }
    r[FULL] = { body: fx('pages/rich.html') }
    const ctx = makeCtx(r, dir)
    const o = await processUrl(AMP, site, ctx)
    expect(o.kind).toBe('emitted')
    expect((ctx.http as ReturnType<typeof fakeHttp>).calls.map((c) => c.url).slice(0, 2)).toEqual([AMP, FULL])

    const ctxNoBody = makeCtx({ 'https://www.example.com/thin': { body: '<html><body><p>Too short.</p></body></html>' } }, tmp())
    const s = await processUrl('https://www.example.com/thin', site, ctxNoBody)
    expect(s.kind).toBe('skipped')
    const f = await processUrl('https://www.example.com/missing', site, ctxNoBody)
    expect(f).toEqual({ kind: 'failed', url: 'https://www.example.com/missing', error: 'HTTP 404' })
  })
})

describe('runSite', () => {
  it('discovers from feeds, archives new stories, skips archived ones next time, honours --limit', async () => {
    const dir = tmp()
    const r = routes()
    const feedXml = `<rss version="2.0"><channel><title>Ex</title>
        <item><title>Scaffolding</title><link>${URL_FEED}</link><pubDate>Thu, 03 Sep 2026 06:00:00 GMT</pubDate></item>
        <item><title>Gone</title><link>https://www.example.com/gone</link></item>
      </channel></rss>`
    r['https://www.example.com/feed.xml'] = { body: feedXml, headers: { etag: '"E1"' } }
    const ctx = makeCtx(r, dir)
    const out1 = await runSite(site, ctx)
    expect(out1.map((o) => o.kind)).toEqual(['emitted', 'failed'])
    expect(ctx.state.feedState.get('https://www.example.com/feed.xml')?.etag).toBe('"E1"')

    const out2 = await runSite(site, ctx)
    expect(out2.map((o: Outcome) => o.kind)).toEqual(['skipped', 'failed'])
    expect(out2[0]).toEqual({ kind: 'skipped', url: CANON, reason: 'already archived' })

    // a 304 on the second poll hides nothing new, as expected
    const http = ctx.http as ReturnType<typeof fakeHttp>
    http.routes['https://www.example.com/feed.xml'] = (opts) => (opts.etag === '"E1"' ? { status: 304 } : { body: feedXml, headers: { etag: '"E1"' } })
    const out2b = await runSite(site, ctx)
    expect(out2b).toEqual([])

    // --refresh bypasses the conditional GET and re-checks archived stories
    const out3 = await runSite(site, { ...ctx, flags: { ...ctx.flags, refresh: true } }, { limit: 1 })
    expect(http.calls.filter((c) => c.url === 'https://www.example.com/feed.xml').at(-1)!.opts.etag).toBeUndefined()
    expect(out3.map((o) => o.kind)).toEqual(['unchanged'])
    expect(ctx.state.feedState.get('https://www.example.com/feed.xml')?.etag).toBe('"E1"')
  })
})
