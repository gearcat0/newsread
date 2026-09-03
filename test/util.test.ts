import { describe, it, expect } from 'vitest'
import { normalizeText, normalizeLines, truncate, dedupeCi } from '../src/util/text.js'
import { toIsoDate, localIsoDate } from '../src/util/dates.js'
import { slugify } from '../src/util/slug.js'
import { normalizeUrl, hostMatches, resolveHttp, isTrackingParam } from '../src/util/url.js'
import { HostLimiter, Semaphore, mapLimit } from '../src/util/limiter.js'
import { parseSrcset, pickCandidate } from '../src/extract/srcset.js'

const NOW = new Date('2026-09-04T12:00:00Z')

describe('text', () => {
  it('normalises whitespace, NBSP and zero-width characters', () => {
    expect(normalizeText('  Hello ​world \n\t there ')).toBe('Hello world there')
  })
  it('keeps newlines for code but trims trailing spaces and collapses runs', () => {
    expect(normalizeLines('a  \r\nb\n\n\n\nc')).toBe('a\nb\n\nc')
  })
  it('truncates on a word boundary', () => {
    expect(truncate('the quick brown fox jumps', 15)).toBe('the quick…')
    expect(truncate('short', 15)).toBe('short')
  })
  it('dedupes case-insensitively preserving order', () => {
    expect(dedupeCi(['Roof', ' works', 'roof', '', 'Works'])).toEqual(['Roof', 'works'])
  })
})

describe('dates', () => {
  it.each([
    ['2026-09-03', '2026-09-03'],
    ['2026-09-03T23:30:00-05:00', '2026-09-03'], // literal date kept, no TZ shift
    ['2026-09-03T02:30:00+05:00', '2026-09-03'],
    ['Thu, 03 Sep 2026 23:30:00 GMT', '2026-09-03'], // RFC 2822 via Date.parse
    ['Thu, 03 Sep 2026 23:30:00 -0500', '2026-09-04'], // no literal date: reported in UTC
    ['September 3, 2026', '2026-09-03'],
    ['2026-13-40', undefined],
    ['2026-02-30', undefined],
    ['1815-06-18', undefined],
    ['2031-01-01', undefined],
    ['not a date', undefined],
    ['', undefined],
    [undefined, undefined]
  ])('toIsoDate(%j) -> %j', (input, expected) => {
    expect(toIsoDate(input as string | undefined, NOW)).toBe(expected)
  })
  it('localIsoDate formats local components', () => {
    const d = new Date(2026, 0, 5, 3, 4)
    expect(localIsoDate(d)).toBe('2026-01-05')
  })
})

describe('slug', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(slugify('Scaffolding goes up on Monday!')).toBe('scaffolding-goes-up-on-monday')
    expect(slugify('Crème brûlée — “quoted”')).toBe('creme-brulee-quoted')
  })
  it('cuts on a hyphen boundary and falls back', () => {
    expect(slugify('one two three four five six', 12)).toBe('one-two')
    expect(slugify('   ')).toBe('untitled')
    expect(slugify(undefined)).toBe('untitled')
  })
})

describe('url', () => {
  it('normalises case, default port, fragment and tracking params; sorts the rest', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/a/b?utm_source=x&z=1&a=2&fbclid=abc#frag')).toBe(
      'https://example.com/a/b?a=2&z=1'
    )
  })
  it('keeps content-selecting params and leaves paths alone', () => {
    expect(normalizeUrl('https://example.com/story/?id=42&page=2')).toBe('https://example.com/story/?id=42&page=2')
    expect(normalizeUrl('https://example.com/story/')).toBe('https://example.com/story/')
  })
  it('rejects non-http', () => {
    expect(normalizeUrl('mailto:a@b.c')).toBeUndefined()
    expect(normalizeUrl('nope')).toBeUndefined()
  })
  it('tracking param detection', () => {
    expect(isTrackingParam('utm_campaign')).toBe(true)
    expect(isTrackingParam('CMP')).toBe(true)
    expect(isTrackingParam('id')).toBe(false)
  })
  it('host suffix matching', () => {
    expect(hostMatches('news.example.com', ['example.com'])).toBe(true)
    expect(hostMatches('example.com', ['example.com'])).toBe(true)
    expect(hostMatches('notexample.com', ['example.com'])).toBe(false)
    expect(hostMatches('a.b.c', ['*.b.c'])).toBe(true)
  })
  it('resolveHttp resolves relative and drops data:/javascript:', () => {
    expect(resolveHttp('/img/x.jpg', 'https://example.com/a/b')).toBe('https://example.com/img/x.jpg')
    expect(resolveHttp('data:image/gif;base64,R0lGOD', 'https://example.com/')).toBeUndefined()
    expect(resolveHttp('javascript:void(0)', 'https://example.com/')).toBeUndefined()
    expect(resolveHttp(undefined, 'https://example.com/')).toBeUndefined()
  })
})

describe('limiter', () => {
  it('serialises per host with a minimum gap, but runs hosts in parallel', async () => {
    let t = 0
    const now = (): number => t
    const lim = new HostLimiter(100, now)
    const order: string[] = []
    const a1 = lim.run('a.com', async () => { order.push('a1'); t += 10 })
    const a2 = lim.run('a.com', async () => { order.push('a2') })
    const b1 = lim.run('b.com', async () => { order.push('b1') })
    await Promise.all([a1, a2, b1])
    expect(order[0]).toBe('a1')
    expect(order).toContain('b1')
    expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1'))
  })
  it('semaphore bounds concurrency', async () => {
    const sem = new Semaphore(2)
    let active = 0, peak = 0
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 5))
          active--
        })
      )
    )
    expect(peak).toBe(2)
  })
  it('mapLimit preserves order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 3))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20])
  })
})

describe('srcset', () => {
  const base = 'https://example.com/story/'
  it('parses w and x descriptors and resolves relative URLs', () => {
    const c = parseSrcset('/a.jpg 320w, /b.jpg 640w,/c.jpg 2x', base)
    expect(c).toEqual([
      { url: 'https://example.com/a.jpg', width: 320 },
      { url: 'https://example.com/b.jpg', width: 640 },
      { url: 'https://example.com/c.jpg', density: 2 }
    ])
  })
  it('survives commas inside URLs (Cloudinary-style)', () => {
    const c = parseSrcset('https://res.example.com/w_300,h_200/x.jpg 300w, https://res.example.com/w_600,h_400/x.jpg 600w')
    expect(c.map((x) => x.url)).toEqual([
      'https://res.example.com/w_300,h_200/x.jpg',
      'https://res.example.com/w_600,h_400/x.jpg'
    ])
    expect(c[1]!.width).toBe(600)
  })
  it('handles a single bare URL and trailing commas', () => {
    expect(parseSrcset('https://example.com/x.jpg')).toEqual([{ url: 'https://example.com/x.jpg' }])
    expect(parseSrcset('https://example.com/x.jpg,')).toEqual([{ url: 'https://example.com/x.jpg' }])
  })
  it('skips data: URLs', () => {
    expect(parseSrcset('data:image/gif;base64,AAAA 1x, /real.jpg 2x', base)).toEqual([
      { url: 'https://example.com/real.jpg', density: 2 }
    ])
  })
  it('pickCandidate prefers largest width, then density', () => {
    expect(pickCandidate([{ url: 'a', width: 300 }, { url: 'b', width: 900 }, { url: 'c', density: 3 }])!.url).toBe('b')
    expect(pickCandidate([{ url: 'a', density: 1 }, { url: 'b', density: 2 }])!.url).toBe('b')
    expect(pickCandidate([{ url: 'a' }, { url: 'b' }])!.url).toBe('a')
    expect(pickCandidate([])).toBeUndefined()
  })
})
