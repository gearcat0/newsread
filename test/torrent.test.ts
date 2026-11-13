import { describe, expect, it } from 'vitest'
import { sha1 } from '@noble/hashes/legacy.js'
import { MAX_LOCATOR_CHARS, bencode, createTorrent, magnetFor, pieceLengthFor, seedFileName } from '../src/torrent.js'

// Vectors produced by the Souspli shell's own create-torrent@6.1.3 (the one
// webtorrent@3.0.21 seeds with) for `Buffer` byte i = (i*7+3) & 255 named
// `article-0123abcd.thing`. If these hold, a reader who seeds the same letter
// lands in the same swarm.
const SHELL_VECTORS: [number, string][] = [
  [1000, 'ff48e79644384776ca641e05c282052673f5b2e2'],
  [70000, 'af2da0118e3af867a557c1f8a4b4fcd04bbff2b2'],
  [300000, 'ee2732b50fd725bb2a872a4675a110d01803d4dd'],
  [3_000_000, '843152762b147bd2d0493286812f3ddba9c01cb4']
]

const pattern = (n: number): Uint8Array => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 255
  return b
}

describe('torrent', () => {
  it('matches the infohash the shell computes when it seeds', () => {
    for (const [n, want] of SHELL_VECTORS) {
      const t = createTorrent(pattern(n), { name: 'article-0123abcd.thing', trackers: ['udp://t.example:6969/announce'], webseeds: ['https://w.example/a'] })
      expect(t.infohash, `${n} bytes`).toBe(want)
    }
  })

  it('trackers, webseeds and dates never change the infohash', () => {
    const bytes = pattern(5000)
    const a = createTorrent(bytes, { name: 'x.thing', trackers: [], webseeds: [], creationDate: 1 })
    const b = createTorrent(bytes, { name: 'x.thing', trackers: ['udp://a/announce', 'http://b/announce'], webseeds: ['https://c/x.thing'], creationDate: 2 })
    expect(a.infohash).toBe(b.infohash)
    expect(a.metainfo).not.toEqual(b.metainfo)
  })

  it('names the file the way the shell does', () => {
    expect(seedFileName('article', 'abcdef0123456789')).toBe('article-abcdef01.thing')
    expect(seedFileName(' ', 'abcdef0123456789')).toBe('thing-abcdef01.thing')
    expect(seedFileName('a b/c', 'ff')).toBe('a-b-c-ff.thing')
  })

  it('follows create-torrent’s piece-length rule', () => {
    expect(pieceLengthFor(1)).toBe(16384)
    expect(pieceLengthFor(3_000_000)).toBe(16384)
    expect(pieceLengthFor(64 * 1024 * 1024)).toBe(65536)
    expect(pieceLengthFor(256 * 1024 * 1024)).toBe(262144)
  })

  it('writes announce-list and url-list into the metainfo, outside info', () => {
    const t = createTorrent(pattern(100), { name: 'n.thing', trackers: ['udp://a/announce', 'http://b/announce'], webseeds: ['https://c/n.thing'], creationDate: 7, createdBy: 'test' })
    const s = new TextDecoder('latin1').decode(t.metainfo)
    expect(s).toContain('8:announce16:udp://a/announce')
    expect(s).toContain('13:announce-listll16:udp://a/announceel17:http://b/announceee')
    expect(s).toContain('8:url-listl17:https://c/n.thinge')
    expect(s).toContain('13:creation datei7e')
    // the infohash is sha1 of exactly the bencoded info dict
    const info = bencode({ length: 100, name: 'n.thing', 'piece length': 16384, pieces: sha1(pattern(100)) })
    expect(t.infohash).toBe(Array.from(sha1(info), (x) => x.toString(16).padStart(2, '0')).join(''))
  })

  it('bencode sorts keys and refuses non-integers', () => {
    expect(new TextDecoder().decode(bencode({ b: 1, a: 'x', c: [1, 'y'] }))).toBe('d1:a1:x1:bi1e1:cli1e1:yee')
    expect(() => bencode(1.5)).toThrow()
  })

  it('builds a magnet the shell can follow and keeps it inside a relay tag', () => {
    const t = { infohash: 'a'.repeat(40), name: 'article-01234567.thing', length: 1234 }
    const m = magnetFor(t, ['udp://tracker.example:6969/announce'], ['https://seed.example/article-01234567.thing'])
    expect(m).toMatch(/^magnet:\?xt=urn:btih:a{40}&dn=article-01234567\.thing&xl=1234&tr=udp%3A%2F%2Ftracker\.example%3A6969%2Fannounce&ws=https%3A%2F%2Fseed\.example%2Farticle-01234567\.thing$/)
    const withXs = magnetFor(t, [], ['https://seed.example/a.thing'], 'https://seed.example/a.thing.torrent')
    expect(withXs).toContain('&xs=https%3A%2F%2Fseed.example%2Fa.thing.torrent&ws=')
    const many = Array.from({ length: 60 }, (_, i) => `udp://tracker-${i}.example.org:6969/announce`)
    const long = magnetFor(t, many, ['https://seed.example/x'])
    expect(long.length).toBeLessThanOrEqual(MAX_LOCATOR_CHARS)
    expect(long).toContain('tr=udp%3A%2F%2Ftracker-0.')
    expect(long).toContain('ws=')
  })
})
