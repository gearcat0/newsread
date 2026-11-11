// A single-file torrent for one .thing, built so its infohash is the one the
// Souspli shell computes when a reader chooses to seed the same letter.
//
// The shell seeds with webtorrent 3.0.21 → create-torrent 6.1.3, giving the
// file the name `${type}-${envelopeHash.slice(0, 8)}.thing` (main.ts
// exportThing) and nothing else in the info dict. If we build the same four
// keys — length, name, piece length, pieces — with the same piece-length rule,
// every reader who turns on seeding joins our swarm instead of starting a
// lonely one of their own. test/torrent.test.ts pins vectors produced by
// create-torrent itself.
//
// The shell reads `files[0]` and refuses anything but a hex btih, so this is
// deliberately single-file, v1 only.
import { sha1 } from '@noble/hashes/legacy.js'
import { concatBytes, utf8 } from './util/bytes.js'

type Bencodable = number | string | Uint8Array | Bencodable[] | { [k: string]: Bencodable | undefined }

export function bencode(v: Bencodable): Uint8Array {
  const parts: Uint8Array[] = []
  const walk = (x: Bencodable): void => {
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x)) throw new Error(`bencode: ${x} is not an integer`)
      parts.push(utf8(`i${x}e`))
    } else if (typeof x === 'string') {
      const b = utf8(x)
      parts.push(utf8(`${b.length}:`), b)
    } else if (x instanceof Uint8Array) {
      parts.push(utf8(`${x.length}:`), x)
    } else if (Array.isArray(x)) {
      parts.push(utf8('l'))
      x.forEach(walk)
      parts.push(utf8('e'))
    } else {
      parts.push(utf8('d'))
      // Keys sort as raw bytes (BEP-3). Every key we write is ASCII, so a
      // plain string sort is the byte sort.
      for (const k of Object.keys(x).sort()) {
        const val = x[k]
        if (val === undefined) continue
        walk(k)
        walk(val)
      }
      parts.push(utf8('e'))
    }
  }
  walk(v)
  return concatBytes(...parts)
}

/** create-torrent's rule (piece-length@2.0.1), capped at its 4 MiB default max. */
export function pieceLengthFor(bytes: number): number {
  const calc = Math.max(16384, (1 << ((Math.log2(bytes < 1024 ? 1 : bytes / 1024) + 0.5) | 0)) | 0)
  return Math.min(calc, 4 * 1024 * 1024)
}

/** The file name the shell gives a letter it seeds. */
export function seedFileName(type: string, envelopeHash: string): string {
  const safeType = (type.trim() || 'thing').replace(/[^a-z0-9-]/gi, '-')
  return `${safeType}-${envelopeHash.slice(0, 8)}.thing`
}

export interface TorrentOptions {
  name: string
  /** Tracker URLs, in announce order. */
  trackers: string[]
  /** BEP-19 webseeds: URLs that serve the exact file bytes. */
  webseeds: string[]
  createdBy?: string
  /** unix seconds; outside the info dict, so it never changes the infohash. */
  creationDate?: number
}

export interface Torrent {
  /** The .torrent metainfo file. */
  metainfo: Uint8Array
  /** 40 lowercase hex chars. */
  infohash: string
  name: string
  length: number
  pieceLength: number
}

export function createTorrent(bytes: Uint8Array, opts: TorrentOptions): Torrent {
  if (bytes.length === 0) throw new Error('torrent: refusing an empty file')
  const pieceLength = pieceLengthFor(bytes.length)
  const hashes: Uint8Array[] = []
  for (let off = 0; off < bytes.length; off += pieceLength) hashes.push(sha1(bytes.subarray(off, off + pieceLength)))
  const info = { length: bytes.length, name: opts.name, 'piece length': pieceLength, pieces: concatBytes(...hashes) }
  const infoBytes = bencode(info)
  const infohash = toHex(sha1(infoBytes))
  const meta: { [k: string]: Bencodable | undefined } = {
    info,
    'creation date': opts.creationDate ?? Math.floor(Date.now() / 1000),
    encoding: 'UTF-8',
    'created by': opts.createdBy ?? 'newsread',
    ...(opts.trackers.length ? { announce: opts.trackers[0]!, 'announce-list': opts.trackers.map((t) => [t]) } : {}),
    ...(opts.webseeds.length ? { 'url-list': opts.webseeds } : {})
  }
  return { metainfo: bencode(meta), infohash, name: opts.name, length: bytes.length, pieceLength }
}

/** The relay's per-tag cap (relay/src/nostr.ts): a `thing-fetch` value longer
 *  than this is refused, so a magnet must fit. */
export const MAX_LOCATOR_CHARS = 2048

/** `magnet:?xt=urn:btih:<hex>&dn=…&xl=…&xs=…&tr=…&ws=…`. Trackers are dropped
 *  from the end, then webseeds, if the result would not fit in a relay tag.
 *
 *  `xs` (exact source) is where the .torrent itself can be downloaded. A magnet
 *  names the content but not its piece hashes, and a webseed serves bytes, not
 *  metadata — so without `xs`, a reader who can reach no peer would wait
 *  forever for metadata the webseed could never give. webtorrent fetches an
 *  http(s) `xs` and checks its infohash. */
export function magnetFor(t: Pick<Torrent, 'infohash' | 'name' | 'length'>, trackers: string[], webseeds: string[], exactSource?: string): string {
  const build = (tr: string[], ws: string[]): string =>
    [
      `magnet:?xt=urn:btih:${t.infohash}`,
      `dn=${encodeURIComponent(t.name)}`,
      `xl=${t.length}`,
      ...(exactSource ? [`xs=${encodeURIComponent(exactSource)}`] : []),
      ...tr.map((u) => `tr=${encodeURIComponent(u)}`),
      ...ws.map((u) => `ws=${encodeURIComponent(u)}`)
    ].join('&')
  let tr = [...trackers]
  let ws = [...webseeds]
  let m = build(tr, ws)
  while (m.length > MAX_LOCATOR_CHARS && tr.length > 1) m = build((tr = tr.slice(0, -1)), ws)
  while (m.length > MAX_LOCATOR_CHARS && ws.length > 1) m = build(tr, (ws = ws.slice(0, -1)))
  if (m.length > MAX_LOCATOR_CHARS) throw new Error(`magnet is ${m.length} chars even with one tracker and one webseed`)
  return m
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
