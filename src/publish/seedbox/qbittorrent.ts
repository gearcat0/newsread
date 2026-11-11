// qBittorrent Web API v2 (qBittorrent ≥ 4.1). libtorrent honours the
// torrent's url-list, so the box pulls the bytes from our webseed by itself.
import { type FetchLike, type SeedBox, type SeedBoxAddOptions, PublishError, failed, joinUrl } from '../types.js'

export interface QbittorrentOptions {
  name: string
  url: string
  username: string
  password: string
  /** Where the box keeps the files. Its default save path when omitted. */
  savePath?: string
  category?: string
  fetch?: FetchLike
}

export class Qbittorrent implements SeedBox {
  readonly kind = 'qbittorrent'
  readonly name: string
  #sid: string | undefined
  readonly #f: FetchLike

  constructor(private readonly o: QbittorrentOptions) {
    this.name = o.name
    this.#f = o.fetch ?? fetch
  }

  async #login(): Promise<void> {
    const res = await this.#f(joinUrl(this.o.url, 'api/v2/auth/login'), {
      method: 'POST',
      // qBittorrent's CSRF check compares Referer/Origin with its own host;
      // sending one that matches is what its own WebUI does.
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: this.o.url },
      body: new URLSearchParams({ username: this.o.username, password: this.o.password }).toString()
    })
    if (!res.ok) await failed(`${this.name}: login`, res)
    const text = await res.text()
    const sid = /\bSID=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
    if (text.trim() !== 'Ok.' || !sid) throw new PublishError(`${this.name}: login refused (${text.trim() || 'no session cookie'})`)
    this.#sid = sid
  }

  /** One request, logging in first and once more if the session expired. */
  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.#sid) await this.#login()
      const res = await this.#f(joinUrl(this.o.url, path), {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), cookie: `SID=${this.#sid}`, referer: this.o.url }
      })
      if (res.status === 403 && attempt === 0) {
        this.#sid = undefined
        continue
      }
      return res
    }
    throw new PublishError(`${this.name}: forbidden after a fresh login`)
  }

  async add(metainfo: Uint8Array, infohash: string, opts: SeedBoxAddOptions): Promise<void> {
    const form = new FormData()
    form.append('torrents', new Blob([metainfo as BlobPart], { type: 'application/x-bittorrent' }), `${opts.name}.torrent`)
    if (this.o.savePath) form.append('savepath', this.o.savePath)
    if (this.o.category) form.append('category', this.o.category)
    form.append('paused', 'false')
    form.append('stopped', 'false') // qBittorrent ≥ 5 renamed paused → stopped
    const res = await this.#call('api/v2/torrents/add', { method: 'POST', body: form })
    if (!res.ok) await failed(`${this.name}: add`, res)
    const text = (await res.text()).trim()
    // "Fails." also means "already there"; the progress query tells them apart.
    if (text === 'Fails.' && (await this.progress(infohash)) === null) throw new PublishError(`${this.name}: add refused`)
  }

  async progress(infohash: string): Promise<number | null> {
    const res = await this.#call(`api/v2/torrents/info?hashes=${infohash}`)
    if (!res.ok) await failed(`${this.name}: info`, res)
    const list = (await res.json()) as { hash?: string; progress?: number }[]
    const t = list.find((x) => x.hash?.toLowerCase() === infohash)
    return t && typeof t.progress === 'number' ? t.progress : null
  }

  async remove(infohash: string): Promise<void> {
    const res = await this.#call('api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: infohash, deleteFiles: 'true' }).toString()
    })
    if (!res.ok) await failed(`${this.name}: delete`, res)
  }
}
