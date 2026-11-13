// Deluge's Web UI JSON-RPC (deluge-web ≥ 2.0). The web server is a client of
// a daemon; we connect it to the first configured daemon if it is not already.
// libtorrent underneath honours url-list webseeds.
import { type FetchLike, type SeedBox, type SeedBoxAddOptions, PublishError, failed, joinUrl, toBase64 } from '../types.js'

export interface DelugeOptions {
  name: string
  /** The web UI base, e.g. http://host:8112 */
  url: string
  password: string
  downloadLocation?: string
  fetch?: FetchLike
}

interface JsonRpcReply {
  result: unknown
  error: { message?: string; code?: number } | null
  id: number
}

export class Deluge implements SeedBox {
  readonly kind = 'deluge'
  readonly name: string
  #cookie: string | undefined
  #id = 0
  readonly #f: FetchLike

  constructor(private readonly o: DelugeOptions) {
    this.name = o.name
    this.#f = o.fetch ?? fetch
  }

  async #raw(method: string, params: unknown[]): Promise<{ reply: JsonRpcReply; res: Response }> {
    const res = await this.#f(joinUrl(this.o.url, 'json'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.#cookie ? { cookie: this.#cookie } : {}) },
      body: JSON.stringify({ method, params, id: ++this.#id })
    })
    if (!res.ok) await failed(`${this.name}: ${method}`, res)
    return { reply: (await res.json()) as JsonRpcReply, res }
  }

  async #login(): Promise<void> {
    const { reply, res } = await this.#raw('auth.login', [this.o.password])
    const cookie = /\b_session_id=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
    if (reply.result !== true || !cookie) throw new PublishError(`${this.name}: login refused`)
    this.#cookie = `_session_id=${cookie}`
    const connected = await this.#call('web.connected', [])
    if (connected !== true) {
      const hosts = (await this.#call('web.get_hosts', [])) as unknown[][]
      const first = hosts[0]?.[0]
      if (typeof first !== 'string') throw new PublishError(`${this.name}: the web UI knows no daemon to connect to`)
      await this.#call('web.connect', [first])
    }
  }

  async #call(method: string, params: unknown[]): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.#cookie && method !== 'auth.login') await this.#login()
      const { reply } = await this.#raw(method, params)
      // Code 1 is "Not authenticated" — the session expired.
      if (reply.error?.code === 1 && attempt === 0) {
        this.#cookie = undefined
        continue
      }
      if (reply.error) throw new PublishError(`${this.name}: ${method}: ${reply.error.message ?? 'error'}`)
      return reply.result
    }
    throw new PublishError(`${this.name}: not authenticated after a fresh login`)
  }

  async add(metainfo: Uint8Array, infohash: string, opts: SeedBoxAddOptions): Promise<void> {
    try {
      await this.#call('core.add_torrent_file', [
        `${opts.name}.torrent`,
        toBase64(metainfo),
        { add_paused: false, ...(this.o.downloadLocation ? { download_location: this.o.downloadLocation } : {}) }
      ])
    } catch (e) {
      // Deluge reports a duplicate as an error; it is success for us.
      if ((await this.progress(infohash)) === null) throw e
    }
  }

  async progress(infohash: string): Promise<number | null> {
    const st = (await this.#call('core.get_torrent_status', [infohash, ['progress', 'state']])) as { progress?: number } | null
    if (!st || typeof st.progress !== 'number') return null
    return st.progress / 100
  }

  async remove(infohash: string): Promise<void> {
    try {
      await this.#call('core.remove_torrent', [infohash, true])
    } catch (e) {
      // Already gone ("InvalidTorrentError: torrent_id … not in session") is
      // what we wanted, as with the other clients.
      if ((await this.progress(infohash)) !== null) throw e
    }
  }
}
