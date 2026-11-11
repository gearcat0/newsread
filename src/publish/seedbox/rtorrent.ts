// rTorrent over XML-RPC: its SCGI port behind an HTTP gateway (nginx
// `scgi_pass`, or ruTorrent's /RPC2).
//
// rTorrent does NOT download from webseeds, so it cannot fetch the bytes the
// way the other clients do. It is pointed at a directory that already holds the
// file (the `dir` webseed writes there: newsread on the same machine, or a
// shared mount), and its hash check on start finds the file complete.
import { type FetchLike, type SeedBox, type SeedBoxAddOptions, PublishError, basicAuth, failed, toBase64 } from '../types.js'

export interface RtorrentOptions {
  name: string
  /** The XML-RPC endpoint, e.g. https://box.example/RPC2 */
  url: string
  username?: string
  password?: string
  /** The directory, as rTorrent sees it, where the `dir` webseed puts the file. */
  directory: string
  fetch?: FetchLike
}

type XmlValue = string | number | { base64: Uint8Array }

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function xmlRpcCall(method: string, params: XmlValue[]): string {
  const value = (v: XmlValue): string =>
    typeof v === 'number'
      ? `<value><i8>${v}</i8></value>`
      : typeof v === 'string'
        ? `<value><string>${esc(v)}</string></value>`
        : `<value><base64>${toBase64(v.base64)}</base64></value>`
  return `<?xml version="1.0"?><methodCall><methodName>${esc(method)}</methodName><params>${params.map((p) => `<param>${value(p)}</param>`).join('')}</params></methodCall>`
}

/** The scalar result of a methodResponse, or a fault. Only what our calls return. */
export function xmlRpcResult(xml: string): { value: string | number } | { fault: string } {
  if (/<fault>/.test(xml)) {
    const msg = /<name>faultString<\/name>\s*<value>(?:<string>)?([\s\S]*?)(?:<\/string>)?<\/value>/.exec(xml)?.[1] ?? 'fault'
    return { fault: msg.trim() }
  }
  const m = /<param>\s*<value>\s*(?:<(i4|i8|int|string)>([\s\S]*?)<\/\1>|([^<]*))\s*<\/value>/.exec(xml)
  if (!m) return { fault: 'unreadable XML-RPC response' }
  if (m[1] && m[1] !== 'string') return { value: Number(m[2]) }
  return { value: (m[2] ?? m[3] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }
}

export class Rtorrent implements SeedBox {
  readonly kind = 'rtorrent'
  readonly name: string
  readonly #f: FetchLike

  constructor(private readonly o: RtorrentOptions) {
    this.name = o.name
    this.#f = o.fetch ?? fetch
  }

  async #call(method: string, params: XmlValue[]): Promise<{ value: string | number } | { fault: string }> {
    const headers: Record<string, string> = { 'content-type': 'text/xml' }
    if (this.o.username !== undefined) headers['authorization'] = basicAuth(this.o.username, this.o.password ?? '')
    const res = await this.#f(this.o.url, { method: 'POST', headers, body: xmlRpcCall(method, params) })
    if (!res.ok) await failed(`${this.name}: ${method}`, res)
    return xmlRpcResult(await res.text())
  }

  async add(metainfo: Uint8Array, infohash: string, _opts: SeedBoxAddOptions): Promise<void> {
    if ((await this.progress(infohash)) !== null) return
    // rTorrent ≥ 0.9 takes a target as the first argument ('' = none); the
    // trailing strings are commands run on the new download before it starts.
    const r = await this.#call('load.raw_start', ['', { base64: metainfo }, `d.directory.set="${this.o.directory.replace(/"/g, '')}"`])
    if ('fault' in r) throw new PublishError(`${this.name}: load.raw_start: ${r.fault}`)
  }

  async progress(infohash: string): Promise<number | null> {
    const h = infohash.toUpperCase() // rTorrent's own spelling
    const size = await this.#call('d.size_bytes', [h])
    if ('fault' in size) return null // "Could not find info-hash."
    const done = await this.#call('d.completed_bytes', [h])
    if ('fault' in done) return null
    const total = Number(size.value)
    return total > 0 ? Number(done.value) / total : 0
  }

  async remove(infohash: string): Promise<void> {
    const r = await this.#call('d.erase', [infohash.toUpperCase()])
    if ('fault' in r) throw new PublishError(`${this.name}: d.erase: ${r.fault}`)
  }
}
