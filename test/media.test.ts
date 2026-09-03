import { describe, it, expect } from 'vitest'
import { sniffMime } from '../src/sniff.js'
import { resolveMedia, eligibleCandidates } from '../src/media.js'
import { DEFAULT_MEDIA } from '../src/config.js'
import type { IrBlock, IrDocument } from '../src/ir.js'
import { fakeHttp } from './helpers/fakeHttp.js'
import * as img from './helpers/images.js'

describe('sniff', () => {
  it('recognises the allowlisted formats and nothing else', () => {
    expect(sniffMime(img.jpeg())).toBe('image/jpeg')
    expect(sniffMime(img.png())).toBe('image/png')
    expect(sniffMime(img.gif())).toBe('image/gif')
    expect(sniffMime(img.webp())).toBe('image/webp')
    expect(sniffMime(img.avif())).toBe('image/avif')
    expect(sniffMime(img.mp4())).toBe('video/mp4')
    expect(sniffMime(img.webm())).toBe('video/webm')
    expect(sniffMime(img.notImage())).toBeUndefined()
    expect(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined()
    expect(sniffMime(new Uint8Array(4))).toBeUndefined()
  })
})

const fig = (urls: (string | { url: string; width?: number })[], alt = ''): IrBlock => ({
  kind: 'figure',
  image: { candidates: urls.map((u) => (typeof u === 'string' ? { url: u } : u)), alt, caption: [] }
})
const doc = (blocks: IrBlock[], lead?: string): IrDocument => ({
  meta: { authors: [], keywords: [], canonicalUrl: 'https://s.com/a', fetchedUrl: 'https://s.com/a', ...(lead ? { leadImage: { candidates: [{ url: lead }], alt: 'lead', caption: [] } } : {}) },
  blocks,
  warnings: []
})
const opts = { media: { ...DEFAULT_MEDIA, concurrency: 2 }, policy: {} }

describe('eligibleCandidates', () => {
  it('filters svg, skip patterns, hosts and small widths; sorts largest first', () => {
    const { tried, skipped } = eligibleCandidates(
      {
        candidates: [
          { url: 'https://c.com/a-400.jpg', width: 400 },
          { url: 'https://c.com/a-1600.jpg', width: 1600 },
          { url: 'https://c.com/logo.png' },
          { url: 'https://c.com/x.svg' },
          { url: 'https://c.com/tiny.jpg', width: 50 },
          { url: 'https://other.com/b.jpg', width: 900 }
        ],
        alt: '',
        caption: []
      },
      { allowHosts: ['c.com'] }
    )
    expect(tried.map((c) => c.url)).toEqual(['https://c.com/a-1600.jpg', 'https://c.com/a-400.jpg'])
    expect(skipped.map((s) => s.reason)).toEqual(['skip pattern', 'svg', 'width 50 < 200', 'host not allowed'])
  })
})

describe('resolveMedia', () => {
  it('downloads, sniffs regardless of content-type, names in document order, dedupes, drops failures', async () => {
    const http = fakeHttp({
      'https://s.com/1.jpg': { body: img.jpeg(1), headers: { 'content-type': 'text/plain' } },
      'https://s.com/2.png': { body: img.png(2) },
      'https://s.com/dup.png': { body: img.png(2) },
      'https://s.com/broken.jpg': { status: 404 },
      'https://s.com/html.jpg': { body: img.notImage(), headers: { 'content-type': 'image/jpeg' } }
    })
    const blocks = [fig(['https://s.com/1.jpg']), fig(['https://s.com/broken.jpg']), fig(['https://s.com/2.png']), fig(['https://s.com/html.jpg']), fig(['https://s.com/dup.png'])]
    const r = await resolveMedia(doc(blocks), http, opts)
    expect(r.byBlock.get(blocks[0]!)?.name).toBe('img-1')
    expect(r.byBlock.get(blocks[0]!)?.mime).toBe('image/jpeg')
    expect(r.byBlock.has(blocks[1]!)).toBe(false)
    expect(r.byBlock.get(blocks[2]!)?.name).toBe('img-2')
    expect(r.byBlock.get(blocks[2]!)?.mime).toBe('image/png')
    expect(r.byBlock.has(blocks[3]!)).toBe(false)
    expect(r.byBlock.has(blocks[4]!)).toBe(false) // duplicate bytes
    expect(r.failed.map((f) => f.reason)).toEqual(['HTTP 404', 'not an accepted type (sniffed unknown)'])
    expect(r.lead).toBeUndefined()
  })
  it('falls through candidates and rejects oversize images', async () => {
    const http = fakeHttp({
      'https://s.com/big.jpg': { body: new Uint8Array(200).fill(0xff) },
      'https://s.com/ok.jpg': { body: img.jpeg(3) }
    })
    const b = fig([{ url: 'https://s.com/big.jpg', width: 2000 }, { url: 'https://s.com/ok.jpg', width: 1000 }])
    const r = await resolveMedia(doc([b]), http, { ...opts, media: { ...opts.media, maxImageBytes: 100 } })
    expect(r.byBlock.get(b)?.url).toBe('https://s.com/ok.jpg')
    expect(r.failed[0]?.reason).toMatch(/too large/)
  })
  it('lead image: auto only when the body has none; always; never; deduped against body', async () => {
    const http = fakeHttp({ 'https://s.com/lead.jpg': { body: img.jpeg(9) }, 'https://s.com/body.jpg': { body: img.jpeg(8) } })
    const r1 = await resolveMedia(doc([], 'https://s.com/lead.jpg'), http, opts)
    expect(r1.lead?.name).toBe('img-1')
    const b = fig(['https://s.com/body.jpg'])
    const r2 = await resolveMedia(doc([b], 'https://s.com/lead.jpg'), http, opts)
    expect(r2.lead).toBeUndefined()
    expect(r2.byBlock.get(b)?.name).toBe('img-1')
    const r3 = await resolveMedia(doc([b], 'https://s.com/lead.jpg'), http, { ...opts, policy: { leadImage: 'always' } })
    expect(r3.lead?.name).toBe('img-1')
    expect(r3.byBlock.get(b)?.name).toBe('img-2')
    const r4 = await resolveMedia(doc([], 'https://s.com/lead.jpg'), http, { ...opts, policy: { leadImage: 'never' } })
    expect(r4.lead).toBeUndefined()
    // lead bytes identical to a body figure: the figure wins, lead dropped
    const same = fig(['https://s.com/lead.jpg'])
    const r5 = await resolveMedia(doc([same], 'https://s.com/lead.jpg'), http, { ...opts, policy: { leadImage: 'always' } })
    expect(r5.lead).toBeUndefined()
    expect(r5.byBlock.get(same)?.name).toBe('img-1')
  })
  it('videos are only fetched when enabled, direct files only, named vid-N', async () => {
    const http = fakeHttp({ 'https://s.com/v.mp4': { body: img.mp4(1) } })
    const v: IrBlock = { kind: 'video', sources: [{ url: 'https://s.com/v.m3u8', mime: 'application/x-mpegURL' }, { url: 'https://s.com/v.mp4', mime: 'video/mp4' }], caption: [] }
    const off = await resolveMedia(doc([v]), http, opts)
    expect(off.byBlock.has(v)).toBe(false)
    const on = await resolveMedia(doc([v]), http, { ...opts, media: { ...opts.media, video: true } })
    expect(on.byBlock.get(v)?.name).toBe('vid-1')
    expect(on.byBlock.get(v)?.mime).toBe('video/mp4')
    expect(http.calls.some((c) => c.url.endsWith('.m3u8'))).toBe(false)
  })
})
