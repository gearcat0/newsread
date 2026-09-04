import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHtml, baseUrlOf, removeAll } from '../src/extract/dom.js'
import { extractBody, domToIr, cleanInlines } from '../src/extract/body.js'
import { extractMeta, applyDateline, splitAuthors, stripTitleSuffix } from '../src/extract/metadata.js'
import { extractJsonLd } from '../src/extract/jsonld.js'
import { collectLinks, inlineText, text, type IrBlock, type IrDocument } from '../src/ir.js'
import type { Site } from '../src/config.js'

const fx = (n: string): string => readFileSync(new URL(`./fixtures/pages/${n}`, import.meta.url), 'utf8')
const URL_RICH = 'https://www.example.com/local/scaffolding-monday?utm_source=feed'
const NOW = new Date('2026-09-04T12:00:00Z')
const site: Site = { id: 'ex', publisher: 'The Example Times', hosts: ['example.com'], feeds: [] }

describe('dom', () => {
  it('injects an absolute base and resolves against it', () => {
    const doc = parseHtml('<p>x</p>', 'https://a.com/b/c')
    expect(doc.querySelector('base')?.getAttribute('href')).toBe('https://a.com/b/c')
    expect(baseUrlOf(doc, 'https://z/').href).toBe('https://a.com/b/c')
    const doc2 = parseHtml('<html><head><base href="/root/"></head><body></body></html>', 'https://a.com/b/c')
    expect(baseUrlOf(doc2, 'https://z/').href).toBe('https://a.com/root/')
  })
  it('removeAll removes and counts', () => {
    const doc = parseHtml('<div><p class="x">a</p><p class="x">b</p><p>c</p></div>', 'https://a.com/')
    expect(removeAll(doc, ['.x', 'nope', ':::bad'])).toBe(2)
    expect(doc.querySelectorAll('p').length).toBe(1)
  })
})

describe('domToIr (selector mode)', () => {
  const doc = parseHtml(fx('rich.html'), URL_RICH)
  const body = extractBody(doc, { ...site, articleSelector: '#main' }, URL_RICH)!
  const ir = domToIr(body.root, baseUrlOf(doc, URL_RICH))
  const kinds = ir.blocks.map((b) => b.kind)

  it('walks the article into typed blocks in order', () => {
    expect(body.via).toBe('selector')
    expect(kinds).toEqual([
      'heading', 'paragraph', 'paragraph', 'figure', 'heading', 'paragraph', 'list', 'heading', 'list',
      'blockquote', 'table', 'code', 'paragraph', 'video', 'embed', 'figure', 'paragraph'
    ])
  })
  it('preserves inline links and emphasis in the IR', () => {
    const p = ir.blocks[2] as Extract<IrBlock, { kind: 'paragraph' }>
    expect(collectLinks(p.inlines)).toEqual([{ href: 'https://www.example.com/statement', text: 'statement' }])
    const p2 = ir.blocks[5] as Extract<IrBlock, { kind: 'paragraph' }>
    expect(p2.inlines.some((i) => i.kind === 'strong')).toBe(true)
    expect(p2.inlines.some((i) => i.kind === 'em')).toBe(true)
    expect(inlineText(p2.inlines)).toMatch(/^The first phase covers the lower courses of masonry, where water ingress/)
  })
  it('figures: picture/srcset/lazy candidates, caption and credit split', () => {
    const f = ir.blocks[3] as Extract<IrBlock, { kind: 'figure' }>
    const urls = f.image.candidates.map((c) => c.url)
    expect(urls).toContain('https://www.example.com/img/face-1600.webp')
    expect(urls).toContain('https://www.example.com/img/face-800.jpg')
    expect(urls.some((u) => u.startsWith('data:'))).toBe(false)
    expect(f.image.candidates.find((c) => c.url.endsWith('face-1600.webp'))?.width).toBe(1600)
    expect(inlineText(f.image.caption)).toBe('The north face on Friday')
    expect(f.image.credit).toBe('Photo: B. Photographer')
    expect(f.image.alt).toBe('Scaffolding on the north face')
    expect(f.image.width).toBe(800)
  })
  it('lists nest, ordered lists keep start, blockquote keeps cite from footer', () => {
    const ul = ir.blocks[6] as Extract<IrBlock, { kind: 'list' }>
    expect(ul.ordered).toBe(false)
    expect(ul.items.length).toBe(3)
    expect(ul.items[1]!.map((b) => b.kind)).toEqual(['paragraph', 'list'])
    expect(collectLinks((ul.items[1]![0] as Extract<IrBlock, { kind: 'paragraph' }>).inlines)[0]?.href).toBe('https://example.org/consolidation')
    const ol = ir.blocks[8] as Extract<IrBlock, { kind: 'list' }>
    expect(ol.ordered).toBe(true)
    expect(ol.start).toBe(3)
    const bq = ir.blocks[9] as Extract<IrBlock, { kind: 'blockquote' }>
    expect(bq.cite).toBe('https://example.com/works-order')
    expect(bq.children.length).toBe(1)
  })
  it('tables, code and media blocks', () => {
    const t = ir.blocks[10] as Extract<IrBlock, { kind: 'table' }>
    expect(inlineText(t.caption!)).toBe('Phase schedule')
    expect(t.rows.length).toBe(3)
    expect(t.rows[0]!.header).toBe(true)
    expect(t.rows[1]!.cells.map((c) => inlineText(c))).toEqual(['One', 'September'])
    const code = ir.blocks[11] as Extract<IrBlock, { kind: 'code' }>
    expect(code.language).toBe('js')
    expect(code.text).toBe('const a = 1;\nconst b = 2;')
    const v = ir.blocks[13] as Extract<IrBlock, { kind: 'video' }>
    expect(v.sources).toEqual([
      { url: 'https://www.example.com/media/timelapse.mp4', mime: 'video/mp4' },
      { url: 'https://www.example.com/media/timelapse.m3u8', mime: 'application/x-mpegURL' }
    ])
    expect(v.poster?.candidates[0]?.url).toBe('https://www.example.com/img/poster.jpg')
    expect(inlineText(v.caption)).toBe('Timelapse of the scaffold going up')
    const e = ir.blocks[14] as Extract<IrBlock, { kind: 'embed' }>
    expect(e.url).toBe('https://www.youtube.com/embed/abc123')
  })
  it('keeps br runs for the flattener and drops nav/aside', () => {
    const p = ir.blocks[12] as Extract<IrBlock, { kind: 'paragraph' }>
    expect(p.inlines.filter((i) => i.kind === 'br').length).toBe(3)
    expect(JSON.stringify(ir.blocks)).not.toContain('Read more')
    expect(JSON.stringify(ir.blocks)).not.toContain('Home')
  })
  it('cleanInlines collapses whitespace and trims edges through nesting', () => {
    const out = cleanInlines([text('  a  '), { kind: 'em', children: [text(' b ')] }, text('  '), { kind: 'br' }])
    expect(out).toEqual([text('a '), { kind: 'em', children: [text(' b ')] }])
  })
})

describe('extractBody (readability mode)', () => {
  it('finds the article and keeps links in the IR', () => {
    const doc = parseHtml(fx('rich.html'), URL_RICH)
    const body = extractBody(doc, site, URL_RICH)!
    expect(body).toBeDefined()
    expect(body.via).toBe('readability')
    expect(body.textLength).toBeGreaterThan(500)
    expect(body.readability?.siteName).toBe('The Example Times')
    const ir = domToIr(body.root, baseUrlOf(doc, URL_RICH))
    const links = ir.blocks.flatMap((b) => (b.kind === 'paragraph' ? collectLinks(b.inlines) : []))
    expect(links.map((l) => l.href)).toContain('https://www.example.com/statement')
    expect(ir.blocks.some((b) => b.kind === 'heading' && inlineText(b.inlines) === 'What is happening')).toBe(true)
    // the original document is untouched by Readability
    expect(doc.querySelector('nav')).not.toBeNull()
  })
  it('reports a tiny text length for a near-empty page so the pipeline can skip it', () => {
    const doc = parseHtml('<html><body><p>hi</p></body></html>', 'https://x.com/')
    const r = extractBody(doc, site, 'https://x.com/')
    expect(r === undefined || r.textLength < 400).toBe(true)
  })
})

describe('metadata', () => {
  it('JSON-LD in @graph wins; arrays and comma strings normalised', () => {
    const doc = parseHtml(fx('rich.html'), URL_RICH)
    const ld = extractJsonLd(doc)!
    expect(ld.type).toBe('NewsArticle')
    expect(ld.authors).toEqual(['A. Reporter', 'B. Photographer'])
    expect(ld.keywords).toEqual(['works', 'roof', 'Works'])
    expect(ld.images).toEqual(['https://cdn.example.com/lead-1200.jpg'])
    const m = extractMeta(doc, { site, fetchedUrl: URL_RICH, now: NOW })
    expect(m.title).toBe('Scaffolding goes up on Monday')
    expect(m.deck).toBe('Works begin at the north face')
    expect(m.authors).toEqual(['A. Reporter', 'B. Photographer'])
    expect(m.publisher).toBe('The Example Times') // config wins over LD
    expect(m.section).toBe('Local')
    expect(m.published).toBe('2026-09-03') // literal date, no TZ shift
    expect(m.updated).toBe('2026-09-04')
    expect(m.language).toBe('en')
    expect(m.rights).toBe('© 2026 The Example Times Ltd')
    expect(m.keywords).toEqual(['works', 'roof'])
    expect(m.location).toBe('Nairobi')
    expect(m.canonicalUrl).toBe('https://www.example.com/local/scaffolding-monday')
    expect(m.leadImage?.candidates[0]?.url).toBe('https://cdn.example.com/lead-1200.jpg')
  })
  it('decodes HTML entities that publishers leave inside JSON-LD strings', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle',
      headline: '&apos;We didn&#39;t want them:&apos; Tom &amp; Jerry &ldquo;rally&rdquo;',
      author: { '@type': 'Person', name: 'O&apos;Brien' },
      keywords: 'A &amp; B, C',
      mainEntityOfPage: 'https://www.example.com/s?a=1&amp;b=2'
    })}</script></head><body></body></html>`
    const doc = parseHtml(html, 'https://www.example.com/s')
    const m = extractMeta(doc, { site, fetchedUrl: 'https://www.example.com/s', now: NOW })
    expect(m.title).toBe("'We didn't want them:' Tom & Jerry “rally”")
    expect(m.authors).toEqual(["O'Brien"])
    expect(m.keywords).toEqual(['A & B', 'C'])
    expect(m.canonicalUrl).toBe('https://www.example.com/s?a=1&b=2')
  })
  it('falls back to OG/meta, strips title suffix, rejects a canonical on a foreign host', () => {
    const url = 'https://other.example.org/quiet?utm_medium=x'
    const doc = parseHtml(fx('og-only.html'), url)
    const s: Site = { id: 'oh', hosts: ['other.example.org'], feeds: [] }
    const m = extractMeta(doc, { site: s, fetchedUrl: url, now: NOW, feed: { published: 'Wed, 02 Sep 2026 06:00:00 GMT' } })
    expect(m.title).toBe('Quiet story')
    expect(m.publisher).toBe('Other Herald')
    expect(m.deck).toBe('A short standfirst.')
    expect(m.authors).toEqual(['C. Writer', 'D. Editor'])
    expect(m.published).toBe('2026-09-03')
    expect(m.keywords).toEqual(['alpha', 'beta'])
    expect(m.rights).toBe('© Other Herald')
    expect(m.canonicalUrl).toBe('https://other.example.org/quiet')
    expect(m.language).toBeUndefined()
  })
  it('AMP page: canonical accepted when on an allowed host', () => {
    const url = 'https://amp.example.com/local/full-story/amp'
    const doc = parseHtml(fx('amp.html'), url)
    const m = extractMeta(doc, { site, fetchedUrl: url, now: NOW })
    expect(m.canonicalUrl).toBe('https://www.example.com/local/full-story')
  })
  it('site.metadata overrides (object and function)', () => {
    const doc = parseHtml(fx('og-only.html'), 'https://other.example.org/q')
    const a = extractMeta(doc, { site: { id: 'x', hosts: ['other.example.org'], feeds: [], metadata: { section: 'Forced' } }, fetchedUrl: 'https://other.example.org/q', now: NOW })
    expect(a.section).toBe('Forced')
    const b = extractMeta(doc, { site: { id: 'x', hosts: ['other.example.org'], feeds: [], metadata: (m) => ({ ...m, title: m.title + '!' }) }, fetchedUrl: 'https://other.example.org/q', now: NOW })
    expect(b.title).toBe('Quiet story!')
  })
  it('splitAuthors and stripTitleSuffix', () => {
    expect(splitAuthors('By Jane Doe, John Roe and Ann Poe')).toEqual(['Jane Doe', 'John Roe', 'Ann Poe'])
    expect(splitAuthors('https://example.com/author/x')).toEqual([])
    expect(stripTitleSuffix('Story - The Times', ['The Times'])).toBe('Story')
    expect(stripTitleSuffix('Story | the times', ['The Times'])).toBe('Story')
    expect(stripTitleSuffix('Story - Other', ['The Times'])).toBe('Story - Other')
  })
  it('applyDateline moves a leading NAIROBI — into location', () => {
    const ir: IrDocument = {
      meta: { authors: [], keywords: [], canonicalUrl: 'https://x/', fetchedUrl: 'https://x/' },
      blocks: [{ kind: 'paragraph', inlines: [text('NAIROBI — Contractors arrive '), { kind: 'em', children: [text('early')] }] }],
      warnings: []
    }
    applyDateline(ir)
    expect(ir.meta.location).toBe('NAIROBI')
    expect(inlineText((ir.blocks[0] as Extract<IrBlock, { kind: 'paragraph' }>).inlines)).toBe('Contractors arrive early')
    const ir2: IrDocument = { ...ir, meta: { ...ir.meta, location: 'Set' }, blocks: [{ kind: 'paragraph', inlines: [text('THIS IS NOT A PLACE NAME AT ALL — text')] }] }
    applyDateline(ir2)
    expect(ir2.meta.location).toBe('Set')
  })
})
