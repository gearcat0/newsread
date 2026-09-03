import { describe, it, expect } from 'vitest'
import { flatten } from '../src/flatten.js'
import { encodedArgsBytes } from '../src/args.js'
import { DEFAULT_LIMITS } from '../src/config.js'
import { text, type IrBlock, type IrDocument } from '../src/ir.js'
import type { MediaResolution } from '../src/media.js'

const meta = (over: Partial<IrDocument['meta']> = {}): IrDocument['meta'] => ({
  title: 'Scaffolding goes up on Monday',
  authors: ['A. Reporter'],
  keywords: ['works'],
  canonicalUrl: 'https://www.example.com/local/scaffolding-monday',
  fetchedUrl: 'https://www.example.com/local/scaffolding-monday',
  publisher: 'The Example Times',
  published: '2026-09-03',
  language: 'en',
  ...over
})
const noMedia = (): MediaResolution => ({ byBlock: new Map(), failed: [], skipped: [] })
const opts = { limits: DEFAULT_LIMITS, retrieved: '2026-09-04' }
const para = (...s: string[]): IrBlock => ({ kind: 'paragraph', inlines: s.map(text) })

describe('flatten', () => {
  it('maps headings, drops the h1 that repeats the title, drops the duplicated standfirst, emits provenance', () => {
    const ir: IrDocument = {
      meta: meta({ deck: 'Works begin at the north face' }),
      blocks: [
        { kind: 'heading', level: 1, inlines: [text('Scaffolding goes up on Monday')] },
        para('Works begin at the north face'),
        para('Body.'),
        { kind: 'heading', level: 2, inlines: [text('What')] },
        { kind: 'heading', level: 3, inlines: [text('Detail')] },
        { kind: 'heading', level: 4, inlines: [text('Finer')] }
      ],
      warnings: []
    }
    const { args } = flatten(ir, noMedia(), opts)
    expect(args.blocks).toEqual([
      { kind: 'paragraph', text: 'Body.' },
      { kind: 'heading', text: 'What' },
      { kind: 'subheading', text: 'Detail' },
      { kind: 'subheading', text: 'Finer' }
    ])
    expect(args.title).toBe('Scaffolding goes up on Monday')
    expect(args.deck).toBe('Works begin at the north face')
    expect(args.retrieved).toBe('2026-09-04')
    expect(args.sourceUrl).toBe('https://www.example.com/local/scaffolding-monday')
    expect(args.publisher).toBe('The Example Times')
    expect(args.byline).toBeUndefined()
    for (const v of Object.values(args)) {
      if (Array.isArray(v)) for (const x of v) expect(typeof x === 'string' || typeof x === 'object').toBe(true)
      else expect(typeof v).toBe('string')
    }
  })
  it('drops link hrefs but keeps their text; emphasis flattened', () => {
    const ir: IrDocument = {
      meta: meta(),
      blocks: [{ kind: 'paragraph', inlines: [text('See the '), { kind: 'link', href: 'https://x/', children: [{ kind: 'strong', children: [text('statement')] }] }, text('.')] }],
      warnings: []
    }
    const { args } = flatten(ir, noMedia(), opts)
    expect(args.blocks).toEqual([{ kind: 'paragraph', text: 'See the statement.' }])
    expect(JSON.stringify(args)).not.toContain('https://x/')
  })
  it('lists become prefixed paragraphs, nested with a dash; blockquotes quoted with cite; br br splits', () => {
    const ir: IrDocument = {
      meta: meta(),
      blocks: [
        { kind: 'list', ordered: false, items: [[para('one')], [para('two'), { kind: 'list', ordered: false, items: [[para('two-a')]] }]] },
        { kind: 'list', ordered: true, start: 3, items: [[para('three')], [para('four')]] },
        { kind: 'blockquote', children: [para('Quoted words.'), para('More.')], cite: 'Diocesan statement' },
        { kind: 'paragraph', inlines: [text('line one,'), { kind: 'br' }, text('line two.'), { kind: 'br' }, { kind: 'br' }, text('New paragraph.')] }
      ],
      warnings: []
    }
    const { args } = flatten(ir, noMedia(), opts)
    expect(args.blocks.map((b) => b.kind === 'paragraph' && b.text)).toEqual([
      '• one', '• two', '– two-a', '3. three', '4. four', '“Quoted words.”', '“More.” — Diocesan statement', 'line one, line two.', 'New paragraph.'
    ])
  })
  it('tables and code flatten to rows/lines; oversize tables become a footnote attached to the previous block', () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ header: false, cells: [[text(`r${i}`)]] }))
    const ir: IrDocument = {
      meta: meta(),
      blocks: [
        para('Intro'),
        { kind: 'table', caption: [text('Schedule')], rows: [{ header: true, cells: [[text('Phase')], [text('Start')]] }, { header: false, cells: [[text('One')], [text('Sep')]] }] },
        { kind: 'table', rows },
        { kind: 'code', text: 'a = 1\n\nb = 2', language: 'py' }
      ],
      warnings: []
    }
    const { args } = flatten(ir, noMedia(), opts)
    expect(args.blocks).toEqual([
      { kind: 'paragraph', text: 'Intro' },
      { kind: 'paragraph', text: 'Schedule' },
      { kind: 'paragraph', text: 'Phase | Start' },
      { kind: 'paragraph', text: 'One | Sep' },
      { kind: 'footnote', text: 'Table omitted (31 rows × 1 columns) — see the original.' },
      { kind: 'paragraph', text: 'a = 1' },
      { kind: 'paragraph', text: 'b = 2' }
    ])
  })
  it('media: resolved figures become image blocks with caption+credit; unresolved dropped; videos/embeds footnoted; footnote-first deferred', () => {
    const f1: IrBlock = { kind: 'figure', image: { candidates: [{ url: 'https://s/1.jpg' }], alt: 'Alt one', caption: [text('Cap')], credit: 'Photo: X' } }
    const f2: IrBlock = { kind: 'figure', image: { candidates: [{ url: 'https://s/2.jpg' }], alt: '', caption: [] } }
    const v: IrBlock = { kind: 'video', sources: [{ url: 'https://s/v.mp4' }], caption: [] }
    const ir: IrDocument = { meta: meta(), blocks: [{ kind: 'embed', url: 'https://yt/e', caption: [] }, f1, f2, v, para('End')], warnings: [] }
    const media: MediaResolution = { byBlock: new Map([[f1, { name: 'img-1', bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', sha256: 'aa', url: 'https://s/1.jpg' }]]), failed: [], skipped: [] }
    const { args, attachments, warnings } = flatten(ir, media, opts)
    expect(args.blocks).toEqual([
      { kind: 'image', name: 'img-1', caption: 'Cap (Photo: X)', alt: 'Alt one', placement: 'full' },
      { kind: 'footnote', text: 'Embedded content omitted: https://yt/e' },
      { kind: 'footnote', text: 'Video not captured: https://s/v.mp4' },
      { kind: 'paragraph', text: 'End' }
    ])
    expect([...attachments.keys()]).toEqual(['img-1'])
    expect(attachments.get('img-1')?.mime).toBe('image/jpeg')
    expect(warnings).toEqual(['image dropped: https://s/2.jpg'])
  })
  it('lead image goes first and is attached', () => {
    const ir: IrDocument = { meta: meta({ leadImage: { candidates: [{ url: 'https://s/l.jpg' }], alt: 'Lead alt', caption: [] } }), blocks: [para('Body')], warnings: [] }
    const media: MediaResolution = { byBlock: new Map(), lead: { name: 'img-1', bytes: new Uint8Array([9]), mime: 'image/jpeg', sha256: 'bb', url: 'https://s/l.jpg' }, failed: [], skipped: [] }
    const { args, attachments } = flatten(ir, media, opts)
    expect(args.blocks[0]).toEqual({ kind: 'image', name: 'img-1', caption: '', alt: 'Lead alt', placement: 'full' })
    expect(attachments.has('img-1')).toBe(true)
  })
  it('caps block count and byte budget with a truncation footnote and drops orphaned attachments', () => {
    const blocks: IrBlock[] = Array.from({ length: 450 }, (_, i) => para(`Paragraph ${i}`))
    const ir: IrDocument = { meta: meta(), blocks, warnings: [] }
    const { args, warnings } = flatten(ir, noMedia(), opts)
    expect(args.blocks.length).toBe(400)
    expect(args.blocks[399]).toEqual({ kind: 'footnote', text: 'Article truncated: 51 further blocks omitted; see the original at https://www.example.com/local/scaffolding-monday.' })
    expect(warnings[0]).toMatch(/truncated: 51 of 450/)

    const big: IrBlock[] = Array.from({ length: 50 }, (_, i) => para('x'.repeat(1000) + i))
    const f: IrBlock = { kind: 'figure', image: { candidates: [{ url: 'https://s/1.jpg' }], alt: '', caption: [] } }
    const media: MediaResolution = { byBlock: new Map([[f, { name: 'img-1', bytes: new Uint8Array(3), mime: 'image/png', sha256: 'cc', url: 'https://s/1.jpg' }]]), failed: [], skipped: [] }
    const r = flatten({ meta: meta(), blocks: [...big, f], warnings: [] }, media, { ...opts, limits: { ...DEFAULT_LIMITS, targetArgsBytes: 10_000 } })
    expect(encodedArgsBytes(r.args)).toBeLessThanOrEqual(10_000)
    expect(r.args.blocks[r.args.blocks.length - 1]!.kind).toBe('footnote')
    expect(r.attachments.size).toBe(0)
  })
})
