// What the publish step talks to. Each is an interface so tests can drive the
// whole pipeline with fakes and no network.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Somewhere that serves a letter's exact bytes over HTTP(S) — a BEP-19
 *  webseed. It is how the bytes reach the seed boxes (they fetch from it as if
 *  it were a peer) and a source that always answers for readers behind NAT. */
export interface WebSeedStore {
  readonly kind: string
  /** Store the bytes under `name`; resolve to the public URL that serves them. */
  put(name: string, bytes: Uint8Array): Promise<string>
  /** True when `url` answers 200 with the expected length. */
  check(url: string, length: number): Promise<boolean>
  /** Delete what `put` stored under `name`, where the store can. */
  remove?(name: string): Promise<void>
}

export interface SeedBoxAddOptions {
  /** The file's name inside the torrent. */
  name: string
  /** The raw bytes, for an adapter that must place them itself. */
  bytes: Uint8Array
}

/** A torrent client reachable over its web API. */
export interface SeedBox {
  /** Operator's label, from config. */
  readonly name: string
  readonly kind: 'qbittorrent' | 'transmission' | 'deluge' | 'rtorrent' | 'fake'
  /** Add the torrent and start it. Adding one that is already there is success. */
  add(metainfo: Uint8Array, infohash: string, opts: SeedBoxAddOptions): Promise<void>
  /** 0..1, or null when the client does not have this torrent. */
  progress(infohash: string): Promise<number | null>
  remove(infohash: string): Promise<void>
}

export class PublishError extends Error {
  override name = 'PublishError'
}

export const toBase64 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')

/** What a response body says, in one line: an HTML error page's <title>
 *  (nginx: "401 Authorization Required"), otherwise its first line. */
export function bodySummary(text: string): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim()
  if (title) return title.slice(0, 200)
  const first = text.split('\n').find((l) => l.trim()) ?? ''
  return /^\s*</.test(first) ? '' : first.trim().slice(0, 200)
}

/** Throw a PublishError carrying what the response body says, for logs. */
export async function failed(what: string, res: Response): Promise<never> {
  const said = bodySummary(await res.text().catch(() => ''))
  throw new PublishError(`${what}: HTTP ${res.status}${said ? ` — ${said}` : ''}`)
}

/** Basic-auth header value. */
export const basicAuth = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

/** Join a base URL and a path without doubling or losing the slash. */
export const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
