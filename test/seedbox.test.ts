// The four adapters against fakes that answer the way each client's API is
// documented to. They pin the request shapes (paths, auth, CSRF dances, the
// duplicate-is-success rules); they are not a substitute for a run against a
// real box (README → Publishing → Checking a seed box).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Qbittorrent } from '../src/publish/seedbox/qbittorrent.js'
import { Transmission } from '../src/publish/seedbox/transmission.js'
import { Deluge } from '../src/publish/seedbox/deluge.js'
import { Rtorrent, xmlRpcCall, xmlRpcResult } from '../src/publish/seedbox/rtorrent.js'
import { DirWebSeed, S3WebSeed, SshWebSeed, shellQuote, signV4, type SshRunner } from '../src/publish/webseed.js'
import type { FetchLike } from '../src/publish/types.js'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Handler = (c: Call) => Response | Promise<Response>

function fakeFetch(handler: Handler): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v
    const c: Call = { url, method: init.method ?? 'GET', headers, body: init.body }
    calls.push(c)
    return handler(c)
  }) as FetchLike & { calls: Call[] }
  f.calls = calls
  return f
}

const json = (v: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
const HASH = 'ab'.repeat(20)
const META = new Uint8Array([100, 101])
const opts = { name: 'article-01234567.thing', bytes: new Uint8Array([1]) }

describe('qBittorrent', () => {
  it('logs in, adds by multipart, reads progress, re-logs in after 403', async () => {
    let sid = 'one'
    let added = false
    const f = fakeFetch(async (c) => {
      if (c.url.endsWith('/api/v2/auth/login')) {
        expect(c.body).toBe('username=admin&password=pw')
        return new Response('Ok.', { headers: { 'set-cookie': `SID=${sid}; HttpOnly; path=/` } })
      }
      if (c.headers['cookie'] !== `SID=${sid}`) return new Response('Forbidden', { status: 403 })
      if (c.url.endsWith('/api/v2/torrents/add')) {
        const form = c.body as FormData
        expect(form.get('savepath')).toBe('/data/things')
        expect(form.get('torrents')).toBeInstanceOf(Blob)
        added = true
        return new Response('Ok.')
      }
      if (c.url.includes('/api/v2/torrents/info?hashes=')) return json(added ? [{ hash: HASH, progress: 0.5 }] : [])
      return new Response('nope', { status: 404 })
    })
    const q = new Qbittorrent({ name: 'qb', url: 'http://box:8080/', username: 'admin', password: 'pw', savePath: '/data/things', fetch: f })
    await q.add(META, HASH, opts)
    expect(await q.progress(HASH)).toBe(0.5)
    sid = 'two' // the session expired on the box
    expect(await q.progress(HASH)).toBe(0.5)
    expect(f.calls.filter((c) => c.url.endsWith('/auth/login'))).toHaveLength(2)
  })

  it('"Fails." is a duplicate only if the box has it', async () => {
    let has = true
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=s' } })
      if (c.url.endsWith('/torrents/add')) return new Response('Fails.')
      return json(has ? [{ hash: HASH, progress: 1 }] : [])
    })
    const q = new Qbittorrent({ name: 'qb', url: 'http://box', username: 'a', password: 'b', fetch: f })
    await q.add(META, HASH, opts)
    has = false
    await expect(q.add(META, HASH, opts)).rejects.toThrow(/add refused/)
  })

  it('a wrong password is a clear error', async () => {
    const q = new Qbittorrent({ name: 'qb', url: 'http://box', username: 'a', password: 'b', fetch: fakeFetch(() => new Response('Fails.')) })
    await expect(q.progress(HASH)).rejects.toThrow(/login refused/)
  })
})

describe('Transmission', () => {
  it('does the 409 session-id dance, then adds with base64 metainfo and basic auth', async () => {
    const f = fakeFetch((c) => {
      if (c.headers['x-transmission-session-id'] !== 'tok') return new Response('', { status: 409, headers: { 'x-transmission-session-id': 'tok' } })
      expect(c.headers['authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
      const body = JSON.parse(c.body as string) as { method: string; arguments: Record<string, unknown> }
      if (body.method === 'torrent-add') {
        expect(body.arguments['metainfo']).toBe(Buffer.from(META).toString('base64'))
        expect(body.arguments['download-dir']).toBe('/srv/seed')
        return json({ result: 'success', arguments: { 'torrent-duplicate': { hashString: HASH } } })
      }
      if (body.method === 'torrent-get') return json({ result: 'success', arguments: { torrents: [{ hashString: HASH, percentDone: 1, error: 0 }] } })
      return json({ result: 'method name not recognized' })
    })
    const t = new Transmission({ name: 'tr', url: 'http://box:9091/transmission/rpc', username: 'u', password: 'p', downloadDir: '/srv/seed', fetch: f })
    await t.add(META, HASH, opts)
    expect(await t.progress(HASH)).toBe(1)
    expect(f.calls[0]!.headers['x-transmission-session-id']).toBe('')
    expect(f.calls.filter((c) => c.headers['x-transmission-session-id'] === 'tok')).toHaveLength(2)
  })

  it('an unknown torrent is null; a torrent error is thrown', async () => {
    let torrents: unknown[] = []
    const t = new Transmission({
      name: 'tr',
      url: 'http://box/transmission/rpc',
      fetch: fakeFetch(() => json({ result: 'success', arguments: { torrents } }))
    })
    expect(await t.progress(HASH)).toBeNull()
    torrents = [{ hashString: HASH, percentDone: 0, error: 3, errorString: 'No data found' }]
    await expect(t.progress(HASH)).rejects.toThrow(/No data found/)
  })
})

describe('Deluge', () => {
  it('logs in, connects the web UI to its daemon, adds and reads progress (0-100)', async () => {
    let connected = false
    const f = fakeFetch((c) => {
      const { method, params, id } = JSON.parse(c.body as string) as { method: string; params: unknown[]; id: number }
      const ok = (result: unknown, headers: Record<string, string> = {}): Response => json({ result, error: null, id }, { headers })
      if (method === 'auth.login') return ok(params[0] === 'deluge', { 'set-cookie': '_session_id=abc; Path=/json' })
      expect(c.headers['cookie']).toBe('_session_id=abc')
      if (method === 'web.connected') return ok(connected)
      if (method === 'web.get_hosts') return ok([['host1', '127.0.0.1', 58846, 'Online']])
      if (method === 'web.connect') {
        expect(params).toEqual(['host1'])
        connected = true
        return ok(null)
      }
      if (method === 'core.add_torrent_file') {
        expect(params[0]).toBe('article-01234567.thing.torrent')
        expect(params[2]).toEqual({ add_paused: false, download_location: '/dl' })
        return ok(HASH)
      }
      if (method === 'core.get_torrent_status') return ok({ progress: 42, state: 'Downloading' })
      return json({ result: null, error: { message: 'Unknown method', code: 2 }, id })
    })
    const d = new Deluge({ name: 'dl', url: 'http://box:8112', password: 'deluge', downloadLocation: '/dl', fetch: f })
    await d.add(META, HASH, opts)
    expect(connected).toBe(true)
    expect(await d.progress(HASH)).toBeCloseTo(0.42)
  })

  it('a duplicate add is success when the torrent is there', async () => {
    const f = fakeFetch((c) => {
      const { method, id } = JSON.parse(c.body as string) as { method: string; id: number }
      if (method === 'auth.login') return json({ result: true, error: null, id }, { headers: { 'set-cookie': '_session_id=s' } })
      if (method === 'web.connected') return json({ result: true, error: null, id })
      if (method === 'core.add_torrent_file') return json({ result: null, error: { message: 'Torrent already in session', code: 4 }, id })
      return json({ result: { progress: 100 }, error: null, id })
    })
    await new Deluge({ name: 'dl', url: 'http://box', password: 'x', fetch: f }).add(META, HASH, opts)
  })
})

describe('rTorrent', () => {
  it('encodes calls and reads scalar results and faults', () => {
    const x = xmlRpcCall('load.raw_start', ['', { base64: new Uint8Array([1, 2]) }, 'd.directory.set="/a&b"'])
    expect(x).toContain('<methodName>load.raw_start</methodName>')
    expect(x).toContain('<base64>AQI=</base64>')
    expect(x).toContain('d.directory.set="/a&amp;b"')
    expect(xmlRpcResult('<methodResponse><params><param><value><i8>123</i8></value></param></params></methodResponse>')).toEqual({ value: 123 })
    expect(xmlRpcResult('<methodResponse><params><param><value>plain</value></param></params></methodResponse>')).toEqual({ value: 'plain' })
    expect(
      xmlRpcResult(
        '<methodResponse><fault><value><struct><member><name>faultCode</name><value><i4>-501</i4></value></member><member><name>faultString</name><value><string>Could not find info-hash.</string></value></member></struct></value></fault></methodResponse>'
      )
    ).toEqual({ fault: 'Could not find info-hash.' })
  })

  it('loads the torrent pointed at the directory, and reads progress from bytes', async () => {
    let loaded = false
    const f = fakeFetch((c) => {
      const body = c.body as string
      const method = /<methodName>(.*?)<\/methodName>/.exec(body)![1]
      const v = (inner: string): Response => new Response(`<?xml version="1.0"?><methodResponse><params><param><value>${inner}</value></param></params></methodResponse>`)
      const fault = (): Response =>
        new Response('<methodResponse><fault><value><struct><member><name>faultString</name><value><string>Could not find info-hash.</string></value></member></struct></value></fault></methodResponse>')
      if (method === 'load.raw_start') {
        expect(body).toContain('d.directory.set="/srv/www/things"')
        loaded = true
        return v('<i4>0</i4>')
      }
      expect(body).toContain(HASH.toUpperCase())
      if (!loaded) return fault()
      if (method === 'd.size_bytes') return v('<i8>200</i8>')
      if (method === 'd.completed_bytes') return v('<i8>200</i8>')
      return fault()
    })
    const r = new Rtorrent({ name: 'rt', url: 'https://box/RPC2', directory: '/srv/www/things', fetch: f })
    expect(await r.progress(HASH)).toBeNull()
    await r.add(META, HASH, opts)
    expect(await r.progress(HASH)).toBe(1)
  })
})

describe('webseeds', () => {
  it('dir: writes the file and returns its public URL; refuses path tricks', async () => {
    const dir = mkdtempSync(join(process.env['NEWSREAD_TEST_TMP'] ?? tmpdir(), 'newsread-ws-'))
    const w = new DirWebSeed({ dir, baseUrl: 'https://seed.example/things/' })
    const url = await w.put('article-01234567.thing', new Uint8Array([9, 8, 7]))
    expect(url).toBe('https://seed.example/things/article-01234567.thing')
    expect([...readFileSync(join(dir, 'article-01234567.thing'))]).toEqual([9, 8, 7])
    await expect(w.put('../etc/passwd', new Uint8Array(1))).rejects.toThrow(/unsafe/)
    await expect(w.put('a/b', new Uint8Array(1))).rejects.toThrow(/unsafe/)
  })

  it('ssh: one bounded ssh per file, written aside then renamed, args quoted', async () => {
    const runs: { args: string[]; input: Uint8Array; timeoutMs: number }[] = []
    const ssh: SshRunner = async (args, input, timeoutMs) => void runs.push({ args, input, timeoutMs })
    const w = new SshWebSeed({ host: 'newsread@dev', dir: "/var/www/it's", baseUrl: 'https://dev.example/n/', port: 2222, ssh })
    const url = await w.put('article-01234567.thing', new Uint8Array([9, 8, 7]))
    expect(url).toBe('https://dev.example/n/article-01234567.thing')
    const r = runs[0]!
    expect([...r.input]).toEqual([9, 8, 7])
    expect(r.timeoutMs).toBe(60_000)
    expect(r.args).toContain('BatchMode=yes')
    expect(r.args).toContain('ServerAliveInterval=5')
    expect(r.args.slice(-3, -1)).toEqual(['--', 'newsread@dev'])
    expect(r.args[r.args.indexOf('-p') + 1]).toBe('2222')
    const cmd = r.args.at(-1)!
    expect(cmd).toContain(`cd ${shellQuote("/var/www/it's")}`)
    expect(cmd).toMatch(/cat > '\.article-01234567\.thing\.tmp' && mv -f '\.article-01234567\.thing\.tmp' 'article-01234567\.thing'$/)
    await w.remove('article-01234567.thing')
    expect(runs[1]!.args.at(-1)).toBe(`rm -f ${shellQuote("/var/www/it's/article-01234567.thing")}`)
    await expect(w.put('../x', new Uint8Array(1))).rejects.toThrow(/unsafe/)
    expect(() => new SshWebSeed({ host: '-oProxyCommand=x', dir: '/d', baseUrl: 'https://d', ssh })).toThrow(/bad ssh host/)
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
  })

  it('SigV4 matches the AWS test suite (get-vanilla)', () => {
    // AWS Signature Version 4 test suite, "get-vanilla".
    const h = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 'service',
      date: new Date('2015-08-30T12:36:00Z'),
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
    })
    expect(h['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    )
  })

  it('s3: PUTs path-style with a content hash and returns the public URL', async () => {
    const f = fakeFetch(() => new Response('', { status: 200 }))
    const w = new S3WebSeed({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'things',
      region: 'auto',
      publicBaseUrl: 'https://seed.example',
      prefix: 'a/',
      accessKeyId: 'k',
      secretAccessKey: 's',
      fetch: f,
      now: () => new Date('2026-11-11T00:00:00Z')
    })
    const url = await w.put('article-01234567.thing', new Uint8Array([1, 2, 3]))
    expect(url).toBe('https://seed.example/a/article-01234567.thing')
    const c = f.calls[0]!
    expect(c.method).toBe('PUT')
    expect(c.url).toBe('https://acct.r2.cloudflarestorage.com/things/a/article-01234567.thing')
    expect(c.headers['x-amz-content-sha256']).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')
    expect(c.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=k\/20261111\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    expect(c.headers['host']).toBeUndefined()
  })

  it('check: HEAD must answer 200 with the right length', async () => {
    let len = '3'
    const w = new DirWebSeed({ dir: '/nonexistent', baseUrl: 'https://s', fetch: fakeFetch(() => new Response(null, { status: 200, headers: { 'content-length': len } })) })
    expect(await w.check('https://s/x', 3)).toBe(true)
    len = '4'
    expect(await w.check('https://s/x', 3)).toBe(false)
  })
})
