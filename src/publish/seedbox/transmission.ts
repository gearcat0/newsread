// Transmission RPC (transmission-daemon ≥ 2.x; the JSON shape is stable through
// 4.x). Transmission downloads from the torrent's url-list webseeds itself.
import { type FetchLike, type SeedBox, type SeedBoxAddOptions, PublishError, basicAuth, failed, toBase64 } from '../types.js'

export interface TransmissionOptions {
  name: string
  /** The RPC endpoint, usually http://host:9091/transmission/rpc */
  url: string
  username?: string
  password?: string
  downloadDir?: string
  fetch?: FetchLike
}

interface RpcReply {
  result: string
  arguments?: Record<string, unknown>
}

export class Transmission implements SeedBox {
  readonly kind = 'transmission'
  readonly name: string
  #session = ''
  readonly #f: FetchLike

  constructor(private readonly o: TransmissionOptions) {
    this.name = o.name
    this.#f = o.fetch ?? fetch
  }

  async #rpc(method: string, args: Record<string, unknown>): Promise<RpcReply> {
    // The CSRF dance: the first request (and any after a daemon restart)
    // answers 409 with the session id to send next time.
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-transmission-session-id': this.#session }
      if (this.o.username !== undefined) headers['authorization'] = basicAuth(this.o.username, this.o.password ?? '')
      const res = await this.#f(this.o.url, { method: 'POST', headers, body: JSON.stringify({ method, arguments: args }) })
      if (res.status === 409) {
        this.#session = res.headers.get('x-transmission-session-id') ?? ''
        continue
      }
      if (!res.ok) await failed(`${this.name}: ${method}`, res)
      const reply = (await res.json()) as RpcReply
      if (reply.result !== 'success') throw new PublishError(`${this.name}: ${method}: ${reply.result}`)
      return reply
    }
    throw new PublishError(`${this.name}: no session id after 409`)
  }

  async add(metainfo: Uint8Array, _infohash: string, _opts: SeedBoxAddOptions): Promise<void> {
    // torrent-duplicate is a success reply, so re-adding is idempotent.
    await this.#rpc('torrent-add', { metainfo: toBase64(metainfo), paused: false, ...(this.o.downloadDir ? { 'download-dir': this.o.downloadDir } : {}) })
  }

  async progress(infohash: string): Promise<number | null> {
    const r = await this.#rpc('torrent-get', { ids: [infohash], fields: ['hashString', 'percentDone', 'error', 'errorString'] })
    const list = (r.arguments?.['torrents'] ?? []) as { hashString?: string; percentDone?: number; error?: number; errorString?: string }[]
    const t = list.find((x) => x.hashString?.toLowerCase() === infohash)
    if (!t) return null
    if (t.error) throw new PublishError(`${this.name}: ${t.errorString || `error ${t.error}`}`)
    return typeof t.percentDone === 'number' ? t.percentDone : 0
  }

  async remove(infohash: string): Promise<void> {
    await this.#rpc('torrent-remove', { ids: [infohash], 'delete-local-data': true })
  }
}
