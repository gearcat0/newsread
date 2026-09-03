// The only module that talks to the network. Resource-bounded and polite:
// per-host serialisation with a gap, timeouts, byte caps enforced while
// streaming, conditional GET, one retry on 5xx/429/network error.
import { HostLimiter, sleep } from './util/limiter.js'
import { concatBytes } from './util/bytes.js'

export interface HttpRequestOptions {
  headers?: Record<string, string>
  maxBytes?: number
  accept?: string
  etag?: string
  lastModified?: string
}

export interface HttpResponse {
  status: number
  /** Final URL after redirects. */
  url: string
  headers: Headers
  body: Uint8Array
}

export interface HttpClient {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>
}

export class HttpError extends Error {
  override name = 'HttpError'
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export interface HttpClientOptions {
  userAgent: string
  perHostDelayMs: number
  timeoutMs: number
  retries: number
  defaultMaxBytes: number
  fetchImpl?: typeof fetch
}

const MAX_RETRY_AFTER_MS = 60_000

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get('retry-after')
  if (!v) return undefined
  const secs = Number(v)
  if (Number.isFinite(secs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, secs * 1000))
  const t = Date.parse(v)
  if (Number.isNaN(t)) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, t - Date.now()))
}

async function readBounded(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw new HttpError(`response too large (${len} > ${maxBytes} bytes)`, url, res.status)
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new HttpError(`response too large (> ${maxBytes} bytes)`, url, res.status)
    }
    chunks.push(value)
  }
  return concatBytes(...chunks)
}

export function createHttpClient(o: HttpClientOptions): HttpClient {
  const limiter = new HostLimiter(o.perHostDelayMs)
  const fetchImpl = o.fetchImpl ?? fetch

  async function attempt(url: string, opts: HttpRequestOptions, tryNo: number): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      'user-agent': o.userAgent,
      accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en',
      ...(opts.headers ?? {})
    }
    if (opts.etag) headers['if-none-match'] = opts.etag
    if (opts.lastModified) headers['if-modified-since'] = opts.lastModified
    const maxBytes = opts.maxBytes ?? o.defaultMaxBytes
    let res: Response
    try {
      res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(o.timeoutMs) })
    } catch (e) {
      if (tryNo < o.retries) {
        await sleep(500 * (tryNo + 1))
        return attempt(url, opts, tryNo + 1)
      }
      throw new HttpError(`fetch failed: ${(e as Error).message}`, url)
    }
    if ((res.status >= 500 || res.status === 429) && tryNo < o.retries) {
      await res.body?.cancel().catch(() => undefined)
      await sleep(retryAfterMs(res.headers) ?? 1000 * (tryNo + 1))
      return attempt(url, opts, tryNo + 1)
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined)
      return { status: 304, url: res.url || url, headers: res.headers, body: new Uint8Array(0) }
    }
    const body = await readBounded(res, maxBytes, url)
    return { status: res.status, url: res.url || url, headers: res.headers, body }
  }

  return {
    async get(url, opts = {}) {
      let host: string
      try {
        host = new URL(url).host
      } catch {
        throw new HttpError('invalid URL', url)
      }
      return limiter.run(host, () => attempt(url, opts, 0))
    }
  }
}

export function assertOk(res: HttpResponse): HttpResponse {
  if (res.status < 200 || res.status >= 300) throw new HttpError(`HTTP ${res.status}`, res.url, res.status)
  return res
}

// ── Charset handling ────────────────────────────────────────────────────────

const META_CHARSET = /<meta[^>]+charset=["']?\s*([a-z0-9_:.-]+)/i
const META_CONTENT_TYPE = /<meta[^>]+content=["'][^"']*charset=([a-z0-9_:.-]+)/i

export function sniffCharset(bytes: Uint8Array, contentType?: string | null): string {
  const fromHeader = /charset=["']?([a-z0-9_:.-]+)/i.exec(contentType ?? '')?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const m = META_CHARSET.exec(head) ?? META_CONTENT_TYPE.exec(head)
  return (m?.[1] ?? 'utf-8').toLowerCase()
}

/** Decode an HTML body: header charset → BOM → <meta charset> → utf-8. */
export function decodeHtml(bytes: Uint8Array, contentType?: string | null): string {
  const label = sniffCharset(bytes, contentType)
  let dec: TextDecoder
  try {
    dec = new TextDecoder(label)
  } catch {
    dec = new TextDecoder('utf-8')
  }
  return dec.decode(bytes)
}
