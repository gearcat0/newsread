// Webseed origins: where a letter's bytes are served over HTTP(S) so seed boxes
// (and readers) can fetch them as BEP-19 webseeds.
//
//   dir — write into a directory some web server already serves (a seed box's
//         own nginx, a shared mount). rTorrent can use this or ssh.
//   ssh — push into such a directory on another machine over ssh. One ssh
//         process per file, with hard timeouts: a dropped link fails the put
//         (and the publish retries) instead of hanging the way a mount does.
//   s3  — PUT to an S3-compatible bucket (R2, B2, MinIO, AWS) with SigV4. No
//         SDK: signing is a page of code over @noble/hashes.
import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { type FetchLike, type WebSeedStore, failed, joinUrl } from './types.js'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function checkName(name: string): void {
  // The name becomes a path segment and a URL segment; refuse anything that
  // could climb out of either.
  if (!SAFE_NAME.test(name) || name.includes('..')) throw new Error(`webseed: unsafe file name ${JSON.stringify(name)}`)
}

async function headOk(f: FetchLike, url: string, length: number): Promise<boolean> {
  try {
    const res = await f(url, { method: 'HEAD' })
    if (!res.ok) return false
    const len = res.headers.get('content-length')
    return len === null || Number(len) === length
  } catch {
    return false
  }
}

export interface DirWebSeedOptions {
  dir: string
  /** The public URL the directory is served at. */
  baseUrl: string
  fetch?: FetchLike
}

export class DirWebSeed implements WebSeedStore {
  readonly kind = 'dir'
  readonly #f: FetchLike
  constructor(private readonly o: DirWebSeedOptions) {
    this.#f = o.fetch ?? fetch
  }

  async put(name: string, bytes: Uint8Array): Promise<string> {
    checkName(name)
    mkdirSync(this.o.dir, { recursive: true })
    const final = join(this.o.dir, name)
    const tmp = `${final}.${process.pid}.tmp`
    writeFileSync(tmp, bytes, { mode: 0o644 })
    renameSync(tmp, final)
    return joinUrl(this.o.baseUrl, encodeURIComponent(name))
  }

  async remove(name: string): Promise<void> {
    checkName(name)
    rmSync(join(this.o.dir, name), { force: true })
  }

  check(url: string, length: number): Promise<boolean> {
    return headOk(this.#f, url, length)
  }
}

/** Runs `ssh <args…>` with `input` on stdin; resolves on exit 0. */
export type SshRunner = (args: string[], input: Uint8Array, timeoutMs: number) => Promise<void>

export const runSsh: SshRunner = (args, input, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`ssh: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`ssh: no answer within ${Math.round(timeoutMs / 1000)}s`))
      else if (code === 0) resolve()
      else reject(new Error(`ssh exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`))
    })
    child.stdin.on('error', () => undefined) // reported through 'close'
    child.stdin.end(input)
  })

/** POSIX single-quoting, for the remote shell. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export interface SshWebSeedOptions {
  /** `user@host`, or a Host alias from ~/.ssh/config. Keys only: ssh runs with BatchMode. */
  host: string
  /** The served directory on that machine. */
  dir: string
  /** The public URL the directory is served at. */
  baseUrl: string
  port?: number
  /** Whole-transfer limit per file (default 60 s). */
  timeoutMs?: number
  fetch?: FetchLike
  ssh?: SshRunner
}

export class SshWebSeed implements WebSeedStore {
  readonly kind = 'ssh'
  readonly #f: FetchLike
  readonly #ssh: SshRunner
  constructor(private readonly o: SshWebSeedOptions) {
    if (o.host.startsWith('-')) throw new Error(`webseed: bad ssh host ${JSON.stringify(o.host)}`)
    this.#f = o.fetch ?? fetch
    this.#ssh = o.ssh ?? runSsh
  }

  #args(command: string): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=3',
      ...(this.o.port ? ['-p', String(this.o.port)] : []),
      '--', this.o.host, command
    ]
  }

  async put(name: string, bytes: Uint8Array): Promise<string> {
    checkName(name)
    const dir = shellQuote(this.o.dir)
    const tmp = shellQuote(`.${name}.tmp`)
    // Written aside and renamed, so a web server never serves half a file.
    const cmd = `umask 022 && mkdir -p ${dir} && cd ${dir} && cat > ${tmp} && mv -f ${tmp} ${shellQuote(name)}`
    await this.#ssh(this.#args(cmd), bytes, this.o.timeoutMs ?? 60_000)
    return joinUrl(this.o.baseUrl, encodeURIComponent(name))
  }

  async remove(name: string): Promise<void> {
    checkName(name)
    await this.#ssh(this.#args(`rm -f ${shellQuote(`${this.o.dir.replace(/\/+$/, '')}/${name}`)}`), new Uint8Array(0), this.o.timeoutMs ?? 60_000)
  }

  check(url: string, length: number): Promise<boolean> {
    return headOk(this.#f, url, length)
  }
}

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface S3WebSeedOptions extends S3Credentials {
  /** e.g. https://<account>.r2.cloudflarestorage.com, https://s3.us-east-1.amazonaws.com */
  endpoint: string
  bucket: string
  /** 'auto' for R2. */
  region: string
  /** Public URL the bucket's objects are served at (a custom domain, r2.dev, …). */
  publicBaseUrl: string
  /** Key prefix inside the bucket, e.g. 'articles/'. */
  prefix?: string
  fetch?: FetchLike
  now?: () => Date
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** RFC 3986 encoding as SigV4 wants it, keeping `/` in paths. */
const uriEncode = (s: string, keepSlash: boolean): string =>
  Array.from(new TextEncoder().encode(s), (b) => {
    const c = String.fromCharCode(b)
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) return c
    return `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }).join('')

export interface SigV4Request {
  method: string
  url: URL
  /** Lower-case names. `host` and `x-amz-date` are added. */
  headers: Record<string, string>
  payloadHash: string
  region: string
  service: string
  date: Date
  credentials: S3Credentials
}

/** AWS Signature Version 4. Returns every header to send, including Authorization. */
export function signV4(r: SigV4Request): Record<string, string> {
  const amzDate = r.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = { ...r.headers, host: r.url.host, 'x-amz-date': amzDate }
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort()
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h]).trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  const query = [...r.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [r.method, uriEncode(decodeURIComponent(r.url.pathname), true), query, canonicalHeaders, signedHeaders, r.payloadHash].join('\n')
  const scope = `${day}/${r.region}/${r.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(sha256(enc(canonical)))].join('\n')
  let key = hmac(sha256, enc(`AWS4${r.credentials.secretAccessKey}`), enc(day))
  for (const part of [r.region, r.service, 'aws4_request']) key = hmac(sha256, key, enc(part))
  const signature = hex(hmac(sha256, key, enc(toSign)))
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

export class S3WebSeed implements WebSeedStore {
  readonly kind = 's3'
  readonly #f: FetchLike
  constructor(private readonly o: S3WebSeedOptions) {
    this.#f = o.fetch ?? fetch
  }

  async put(name: string, bytes: Uint8Array): Promise<string> {
    checkName(name)
    const key = `${(this.o.prefix ?? '').replace(/^\/+/, '')}${name}`
    // Path-style addressing works on every S3-compatible store.
    const url = new URL(joinUrl(this.o.endpoint, `${this.o.bucket}/${key}`))
    const headers = signV4({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-content-sha256': hex(sha256(bytes))
      },
      payloadHash: hex(sha256(bytes)),
      region: this.o.region,
      service: 's3',
      date: (this.o.now ?? (() => new Date()))(),
      credentials: this.o
    })
    delete headers['host'] // fetch sets it; sending it twice is an error in undici
    const res = await this.#f(url.toString(), { method: 'PUT', headers, body: bytes as BodyInit })
    if (!res.ok) await failed('webseed PUT', res)
    return joinUrl(this.o.publicBaseUrl, uriEncode(key, true))
  }

  check(url: string, length: number): Promise<boolean> {
    return headOk(this.#f, url, length)
  }
}
