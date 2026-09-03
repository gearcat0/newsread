import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpClient, decodeHtml, sniffCharset, HttpError } from '../src/http.js'

let server: Server
let base: string
let hits: Record<string, number> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/'
    hits[path] = (hits[path] ?? 0) + 1
    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' })
      res.end('<p>hello</p>')
    } else if (path === '/cond') {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304)
        res.end()
      } else {
        res.writeHead(200, { etag: '"v1"' })
        res.end('fresh')
      }
    } else if (path === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(5000, 1))
    } else if (path === '/big-nolen') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write(Buffer.alloc(3000, 1))
      res.end(Buffer.alloc(3000, 1))
    } else if (path === '/flaky') {
      if (hits[path] === 1) {
        res.writeHead(503, { 'retry-after': '0' })
        res.end('nope')
      } else {
        res.writeHead(200)
        res.end('recovered')
      }
    } else if (path === '/redirect') {
      res.writeHead(302, { location: '/ok' })
      res.end()
    } else if (path === '/notfound') {
      res.writeHead(404)
      res.end('gone')
    } else if (path === '/ua') {
      res.writeHead(200)
      res.end(String(req.headers['user-agent']))
    } else {
      res.writeHead(500)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const client = () =>
  createHttpClient({ userAgent: 'newsread-test/0', perHostDelayMs: 0, timeoutMs: 5000, retries: 1, defaultMaxBytes: 4096 })

describe('http client', () => {
  it('gets a body and exposes headers and final URL', async () => {
    const r = await client().get(`${base}/ok`)
    expect(r.status).toBe(200)
    expect(new TextDecoder().decode(r.body)).toBe('<p>hello</p>')
    expect(r.headers.get('etag')).toBe('"v1"')
    expect(r.url).toBe(`${base}/ok`)
  })
  it('sends the configured user agent', async () => {
    const r = await client().get(`${base}/ua`)
    expect(new TextDecoder().decode(r.body)).toBe('newsread-test/0')
  })
  it('follows redirects and reports the final URL', async () => {
    const r = await client().get(`${base}/redirect`)
    expect(r.status).toBe(200)
    expect(r.url).toBe(`${base}/ok`)
  })
  it('does a conditional GET and returns 304 with an empty body', async () => {
    const r = await client().get(`${base}/cond`, { etag: '"v1"' })
    expect(r.status).toBe(304)
    expect(r.body.length).toBe(0)
  })
  it('rejects oversize bodies by content-length and while streaming', async () => {
    await expect(client().get(`${base}/big`)).rejects.toBeInstanceOf(HttpError)
    await expect(client().get(`${base}/big-nolen`)).rejects.toThrow(/too large/)
    const ok = await client().get(`${base}/big`, { maxBytes: 10_000 })
    expect(ok.body.length).toBe(5000)
  })
  it('retries once on 5xx', async () => {
    hits = {}
    const r = await client().get(`${base}/flaky`)
    expect(r.status).toBe(200)
    expect(hits['/flaky']).toBe(2)
  })
  it('returns 4xx rather than throwing', async () => {
    const r = await client().get(`${base}/notfound`)
    expect(r.status).toBe(404)
  })
})

describe('charset', () => {
  it('prefers the header, then BOM, then <meta>, then utf-8', () => {
    const latin1 = Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>caf\xe9</body></html>', 'latin1')
    expect(sniffCharset(latin1)).toBe('iso-8859-1')
    expect(decodeHtml(latin1)).toContain('café')
    expect(sniffCharset(latin1, 'text/html; charset=windows-1252')).toBe('windows-1252')
    const http = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">', 'latin1')
    expect(sniffCharset(http)).toBe('shift_jis')
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
    expect(sniffCharset(bom)).toBe('utf-8')
    expect(sniffCharset(new TextEncoder().encode('<p>x</p>'))).toBe('utf-8')
  })
  it('falls back to utf-8 on an unknown label', () => {
    const bytes = Buffer.from('<meta charset="x-bogus-9"><p>ok</p>')
    expect(decodeHtml(bytes)).toContain('ok')
  })
})
