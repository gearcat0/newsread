// A minimal NIP-01 relay client: EVENT/OK to post, REQ/EOSE/EVENT to read,
// CLOSE, and reconnect-with-backoff for long-lived subscriptions. Node 24's
// global WebSocket by default; tests inject a fake socket.
import type { NostrEvent } from '../souspli.js'

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', fn: () => void): void
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void
}

export type SocketFactory = (url: string) => SocketLike

export interface Filter {
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  authors?: string[]
  [tag: `#${string}`]: string[] | undefined
}

export interface PublishResult {
  ok: boolean
  message: string
}

export interface RelayLog {
  info(m: string): void
  warn(m: string): void
  debug(m: string): void
}

interface Sub {
  /** recomputed on every (re)connect, so `since` follows the cursor */
  filters: () => Filter[]
  onEvent: (ev: unknown) => void
  onEose?: () => void
}

const OPEN = 1

export interface RelayClientOptions {
  socket?: SocketFactory
  log?: RelayLog
  /** ms to wait for OK after EVENT */
  okTimeoutMs?: number
  connectTimeoutMs?: number
  /** first reconnect delay; doubles to maxBackoffMs */
  backoffMs?: number
  maxBackoffMs?: number
}

const quiet: RelayLog = { info: () => undefined, warn: () => undefined, debug: () => undefined }

export class RelayClient {
  #ws: SocketLike | undefined
  #opening: Promise<SocketLike> | undefined
  readonly #subs = new Map<string, Sub>()
  readonly #pendingOk = new Map<string, (r: PublishResult) => void>()
  #closed = false
  #backoff: number
  #timer: ReturnType<typeof setTimeout> | undefined
  readonly #o: Required<Omit<RelayClientOptions, 'socket' | 'log'>> & { socket: SocketFactory; log: RelayLog }

  constructor(
    readonly url: string,
    opts: RelayClientOptions = {}
  ) {
    this.#o = {
      socket: opts.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike),
      log: opts.log ?? quiet,
      okTimeoutMs: opts.okTimeoutMs ?? 15_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 15_000,
      backoffMs: opts.backoffMs ?? 2_000,
      maxBackoffMs: opts.maxBackoffMs ?? 120_000
    }
    this.#backoff = this.#o.backoffMs
  }

  #connect(): Promise<SocketLike> {
    if (this.#closed) return Promise.reject(new Error(`${this.url}: client closed`))
    if (this.#ws && this.#ws.readyState === OPEN) return Promise.resolve(this.#ws)
    if (this.#opening) return this.#opening
    this.#opening = new Promise<SocketLike>((resolve, reject) => {
      let ws: SocketLike
      try {
        ws = this.#o.socket(this.url)
      } catch (e) {
        this.#opening = undefined
        reject(e as Error)
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.#opening = undefined
        try {
          ws.close()
        } catch {
          /* already gone */
        }
        reject(new Error(`${this.url}: connect timed out`))
      }, this.#o.connectTimeoutMs)
      ws.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#ws = ws
        this.#opening = undefined
        this.#backoff = this.#o.backoffMs
        for (const [id, s] of this.#subs) ws.send(JSON.stringify(['REQ', id, ...s.filters()]))
        resolve(ws)
      })
      ws.addEventListener('message', (m) => this.#onMessage(m.data))
      ws.addEventListener('error', () => this.#o.log.debug(`${this.url}: socket error`))
      ws.addEventListener('close', () => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          this.#opening = undefined
          reject(new Error(`${this.url}: connection refused or closed`))
        }
        if (this.#ws === ws) this.#ws = undefined
        for (const [, done] of this.#pendingOk) done({ ok: false, message: 'connection closed before OK' })
        this.#pendingOk.clear()
        this.#scheduleReconnect()
      })
    })
    return this.#opening
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#subs.size === 0 || this.#timer) return
    const delay = this.#backoff
    this.#backoff = Math.min(this.#backoff * 2, this.#o.maxBackoffMs)
    this.#o.log.debug(`${this.url}: reconnecting in ${delay} ms`)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#connect().catch((e: Error) => {
        this.#o.log.warn(e.message)
        this.#scheduleReconnect()
      })
    }, delay)
    this.#timer.unref?.()
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    const [type, a, b, c] = msg as [unknown, unknown, unknown, unknown]
    if (type === 'EVENT' && typeof a === 'string') this.#subs.get(a)?.onEvent(b)
    else if (type === 'EOSE' && typeof a === 'string') this.#subs.get(a)?.onEose?.()
    else if (type === 'OK' && typeof a === 'string') {
      const done = this.#pendingOk.get(a)
      if (done) {
        this.#pendingOk.delete(a)
        done({ ok: b === true, message: typeof c === 'string' ? c : '' })
      }
    } else if (type === 'CLOSED' && typeof a === 'string') {
      this.#o.log.warn(`${this.url}: subscription ${a} closed by relay: ${String(b ?? '')}`)
    } else if (type === 'NOTICE') this.#o.log.warn(`${this.url}: notice: ${String(a ?? '')}`)
  }

  /** Post an event and wait for the relay's OK. A duplicate counts as accepted. */
  async publish(ev: NostrEvent): Promise<PublishResult> {
    let ws: SocketLike
    try {
      ws = await this.#connect()
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    return new Promise<PublishResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingOk.delete(ev.id)
        resolve({ ok: false, message: 'no OK from relay in time' })
      }, this.#o.okTimeoutMs)
      this.#pendingOk.set(ev.id, (r) => {
        clearTimeout(timer)
        resolve(r.ok || /^duplicate:/.test(r.message) ? { ok: true, message: r.message } : r)
      })
      ws.send(JSON.stringify(['EVENT', ev]))
    })
  }

  /** Keep a subscription open (re-sent after every reconnect). */
  subscribe(id: string, filters: () => Filter[], onEvent: (ev: unknown) => void, onEose?: () => void): void {
    this.#subs.set(id, { filters, onEvent, ...(onEose ? { onEose } : {}) })
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify(['REQ', id, ...filters()]))
    else
      this.#connect().catch((e: Error) => {
        this.#o.log.warn(e.message)
        this.#scheduleReconnect()
      })
  }

  unsubscribe(id: string): void {
    if (!this.#subs.delete(id)) return
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify(['CLOSE', id]))
  }

  /** Read what is stored until EOSE, then close the subscription. */
  async fetchStored(filters: Filter[], onEvent: (ev: unknown) => void, timeoutMs = 30_000): Promise<'eose' | 'timeout'> {
    const id = `once-${Math.random().toString(36).slice(2, 10)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.unsubscribe(id)
        resolve('timeout')
      }, timeoutMs)
      this.subscribe(
        id,
        () => filters,
        onEvent,
        () => {
          clearTimeout(timer)
          this.unsubscribe(id)
          resolve('eose')
        }
      )
    })
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#subs.clear()
    try {
      this.#ws?.close()
    } catch {
      /* already gone */
    }
    this.#ws = undefined
  }
}
